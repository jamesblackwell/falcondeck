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
    var snapshotRaw: JSON = .null {
        didSet {
            let value = snapshotRaw["extensions"]
            if localExtensions != value { localExtensions = value }
        }
    }
    // Task lists observe this projection instead of unrelated snapshot usage,
    // notices and scheduling updates. Keep raw snapshot consumers live too.
    private var localExtensions: JSON = .null
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
    @ObservationIgnored private let readVisibility: @MainActor () -> Bool
    @ObservationIgnored private var connectionTask: Task<Void, Never>?
    @ObservationIgnored private var loadID = UUID()
    @ObservationIgnored private var navigationID = UUID()
    @ObservationIgnored private var olderLoadID: UUID?
    @ObservationIgnored private var loadedTaskID: String?
    @ObservationIgnored private var connectionID = UUID()
    @ObservationIgnored private var bufferedEvents: [JSON] = []
    @ObservationIgnored private var bufferedOverflow = false
    @ObservationIgnored private var recoveryTask: Task<Void, Never>?
    @ObservationIgnored private var recoveryID = UUID()
    @ObservationIgnored private var hostTask: Task<Void, Never>?
    @ObservationIgnored private var localSnapshot: JSON = .null
    @ObservationIgnored private var localEventRevision: UInt64 = 0
    // Raw host replay caches change on every envelope. Only their explicit UI
    // projections should participate in SwiftUI observation.
    @ObservationIgnored private var remoteSnapshots: [String: JSON] = [:]
    private var remoteNavigationPreferences: [String: JSON] = [:]
    private var remoteExtensions: [String: JSON] = [:]
    private var remoteStatuses: [String: NativeHostStatus] = [:]
    @ObservationIgnored private var preferenceRevision: [String: UInt64] = [:]
    @ObservationIgnored private var preferenceWrites: [String: Task<Void, Error>] = [:]
    @ObservationIgnored private var lastReadSequences: [String: Int] = [:]
    private struct PendingRead { let id: UUID; let sequence: Int }
    @ObservationIgnored private var pendingReads: [String: PendingRead] = [:]
    private var projectOrderSlots: [String] = []
    private struct Navigation: Equatable {
        var section: String
        var project: String?
        var task: String?
        var extensionID: String?
        var panelID: String?
    }
    @ObservationIgnored private var navigationHistory: [Navigation] = []
    @ObservationIgnored private var navigationIndex = -1
    @ObservationIgnored private var taskNavigationIDs: [String] = []
    @ObservationIgnored private var taskNavigationSection: String?
    @ObservationIgnored private var taskNavigationProject: String?
    var selectedHostID: String? { selectedProjectID.flatMap { NativeHostManager.split($0).hostID } }
    var isSelectedHostConnected: Bool {
        guard let host = selectedHostID else { return isConnected }
        return remoteStatuses[host] == .connected
    }

    init(client: any DaemonServing = DaemonClient(), inputStore: NativeInputStore? = nil,
         readVisibility: (@MainActor () -> Bool)? = nil) {
        self.client = client
        self.inputStore = inputStore ?? (client is DaemonClient ? .shared : nil)
        self.readVisibility = readVisibility ?? {
            NSApp?.isActive == true && NSApp?.keyWindow != nil && NativePlatform.nativeDesktopPresence() != false
        }
        if client is DaemonClient {
            projectOrderSlots = UserDefaults.standard.stringArray(forKey: "falcondeck.native.projectOrderSlots") ?? []
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
        guard let hostID else { return localExtensions }
        return remoteExtensions[hostID] ?? .null
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
            $0.projectID == selectedProjectID && !$0.pinned && !$0.raw["is_archived"].bool &&
            (searchText.isEmpty || $0.title.localizedCaseInsensitiveContains(searchText) || $0.preview.localizedCaseInsensitiveContains(searchText))
        }.sorted {
            if $0.raw["is_pinned_in_project"].bool != $1.raw["is_pinned_in_project"].bool { return $0.raw["is_pinned_in_project"].bool }
            return $0.updatedAt > $1.updatedAt
        }
    }

    func reconnect() async {
        connectionTask?.cancel()
        connectionID = UUID()
        let identity = connectionID
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
                let restored = try await inputStore?.loadWithRevision()
                guard connectionID == identity else { return }
                let saved = restored?.value ?? .init()
                inputRevision = max(inputRevision, restored?.revision ?? 0)
                for (key, value) in saved.drafts where drafts[key] == nil { drafts[key] = value }
                for (key, value) in saved.payloads where composerPayloads[key] == nil { composerPayloads[key] = value }
                for (key, var value) in saved.submissions where inputSubmissions[key] == nil {
                    // A check or POST interrupted by app termination cannot establish delivery.
                    if value.status == .checking { value.status = .uncertain }
                    inputSubmissions[key] = value
                }
                didLoadInputs = true
            } catch {
                guard connectionID == identity else { return }
                errorMessage = "Saved input couldn’t be read. \(error.localizedDescription)"
            }
        }
        await client.disconnect()
        guard connectionID == identity else { return }
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
                                    await self.selectTask(id, navigating: false)
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
        navigationID = UUID()
        selectedSection = allProjects.first(where: { $0.id == id })?.raw["kind"].string == "casual" ? "chats" : "project"
        if selectedProjectID == id, selectedTask?.pinned != true { recordNavigation(); return }
        selectedProjectID = id
        newTask()
        let latest = filteredTasks.first
        if let latest {
            let navigation = navigationID
            Task {
                guard navigationID == navigation, selectedProjectID == id, selectedTaskID == nil else { return }
                await selectTask(latest.id)
            }
        }
    }

    func newTask(recordHistory: Bool = true) {
        NativeAudioPlayback.shared.stop()
        NativeAudioPlayback.shared.stopRealtime()
        navigationID = UUID()
        selectedSection = selectedProject?.raw["kind"].string == "casual" ? "chats" : "project"
        loadID = UUID()
        olderLoadID = nil
        isLoadingOlder = false
        loadedTaskID = nil
        recoveryID = UUID()
        recoveryTask?.cancel(); recoveryTask = nil
        selectedTaskID = nil
        transcript = Transcript()
        bufferedEvents = []
        bufferedOverflow = false
        isLoading = false
        hasOlder = false
        provider = selectedProject?.raw["default_provider"].string ?? "codex"
        if !availableProviders.contains(provider) { provider = availableProviders.first ?? "codex" }
        errorMessage = nil
        recordNavigation(addingHistory: recordHistory)
    }

    func selectTask(_ id: String, navigating: Bool = true, recordHistory: Bool = true) async {
        guard let task = tasks.first(where: { $0.id == id }) else { return }
        let beginsReading = navigating || loadedTaskID != id
        if navigating {
            navigationID = UUID()
            if selectedTaskID != id {
                NativeAudioPlayback.shared.stop()
                NativeAudioPlayback.shared.stopRealtime()
            }
            recoveryID = UUID()
            recoveryTask?.cancel(); recoveryTask = nil
        } else if selectedTaskID != id { return }
        let identity = UUID()
        loadID = identity
        olderLoadID = nil
        isLoadingOlder = false
        loadedTaskID = nil
        selectedTaskID = id
        selectedProjectID = task.projectID
        if let host = NativeHostManager.split(task.projectID).hostID {
            Task { await NativeHostManager.shared.selectThread(hostID: host, threadID: NativeHostManager.split(id).id) }
        }
        if navigating {
            if task.pinned, !task.raw["is_archived"].bool || selectedSection == "pins" { selectedSection = "pins" }
            else { selectedSection = allProjects.first(where: { $0.id == task.projectID })?.raw["kind"].string == "casual" ? "chats" : "project" }
        }
        if navigating { recordNavigation(addingHistory: recordHistory) }
        provider = task.provider
        if navigating { transcript = Transcript() }
        bufferedEvents = []
        bufferedOverflow = false
        hasOlder = false
        isLoading = true
        defer {
            if loadID == identity {
                isLoading = false
                scheduleRecoveryIfNeeded(for: id)
                if loadedTaskID == id { markSelectedTaskRead() }
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
            loadedTaskID = id
            if beginsReading, selectedTask?.unread == true {
                lastReadSequences.removeValue(forKey: id)
                pendingReads.removeValue(forKey: id)
            }
            errorMessage = nil
        } catch {
            guard loadID == identity else { return }
            if !navigating {
                for event in bufferedEvents { transcript.apply(event) }
                if bufferedOverflow { transcript.needsRecovery = true }
                bufferedEvents = []
            }
            errorMessage = "Couldn’t load this task. \(error.localizedDescription)"
        }
    }

    func loadOlder() async {
        guard hasOlder, !isLoadingOlder, let task = selectedTask, let before = messages.first?.id else { return }
        let identity = loadID
        let pageIdentity = UUID()
        olderLoadID = pageIdentity
        isLoadingOlder = true
        defer { if olderLoadID == pageIdentity { olderLoadID = nil; isLoadingOlder = false } }
        do {
            let detail = try await loadDetail(task: task, before: before)
            guard loadID == identity else { return }
            transcript.prepend(detail["items"].array.map(Message.init))
            hasOlder = detail["has_older"].bool
        } catch { if loadID == identity { errorMessage = error.localizedDescription } }
    }

    func openProject(path: String) async {
        let navigation = navigationID
        do {
            let project = try await client.connectProject(path: path)
            if !projects.contains(where: { $0.id == project.id }) { projects.append(project) }
            if !allProjects.contains(where: { $0.id == project.id }) { allProjects.append(project) }
            if navigationID == navigation { selectProject(project.id) }
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
        if originHost == nil { localEventRevision &+= 1 }
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
            if !allProjects.contains(where: { $0.id == selectedProjectID }), !isAwaitingRemoteSelection {
                let projectIDs = Set(projects.map(\.id))
                selectedProjectID = tasks.filter { projectIDs.contains($0.projectID) }.max { $0.updatedAt < $1.updatedAt }?.projectID ?? projects.first?.id
                newTask()
            }
            if let id = selectedTaskID, !tasks.contains(where: { $0.id == id }), !isAwaitingRemoteSelection { newTask() }
        case "thread-started", "thread-updated":
            upsertTask(event["thread"])
            if event["thread"]["id"].string == selectedTaskID { markSelectedTaskRead() }
        case "workspace-updated":
            let project = Project(event["workspace"])
            if let index = allProjects.firstIndex(where: { $0.id == project.id }) { allProjects[index] = project }
            else { allProjects.append(project) }
            guard !["scratch", "casual"].contains(project.raw["kind"].string) else {
                projects.removeAll { $0.id == project.id }; return
            }
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
            let initialLoad = loadID
            let identity = UUID()
            recoveryID = identity
            recoveryTask = Task {
                defer { if recoveryID == identity { recoveryTask = nil } }
                var expectedLoad = initialLoad
                for attempt in 0..<3 {
                    guard !Task.isCancelled, selectedTaskID == taskID, loadID == expectedLoad else { return }
                    await selectTask(taskID, navigating: false)
                    guard !Task.isCancelled, selectedTaskID == taskID, recoveryID == identity,
                          transcript.needsRecovery else { return }
                    expectedLoad = loadID
                    if attempt == 2 {
                        errorMessage = "This conversation is still catching up. Reopen the task to reload its latest messages."
                        return
                    }
                    do { try await Task.sleep(for: .milliseconds(250 * (attempt + 1))) }
                    catch { return }
                }
            }
        }
    }

    private func upsertTask(_ raw: JSON) {
        let task = AgentTask(raw)
        guard !task.id.isEmpty else { return }
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = AgentTask(NativeHostProjection.mergeTask(previous: tasks[index].raw, incoming: raw))
        } else { tasks.append(task) }
    }

    func selectSection(_ section: String) {
        navigationID = UUID()
        selectedSection = section
        if section == "chats" || section == "pins" {
            let candidates = tasks.filter { task in
                if section == "pins" { return task.pinned && !task.raw["is_archived"].bool }
                return allProjects.first(where: { $0.id == task.projectID })?.raw["kind"].string == "casual" && !task.pinned && !task.raw["is_archived"].bool
            }.sorted { $0.updatedAt > $1.updatedAt }
            if !candidates.contains(where: { $0.id == selectedTaskID }) {
                if let task = candidates.first {
                    if selectedTaskID != task.id {
                        NativeAudioPlayback.shared.stop()
                        NativeAudioPlayback.shared.stopRealtime()
                    }
                    selectedProjectID = task.projectID
                    selectedTaskID = task.id
                    transcript = Transcript()
                    loadedTaskID = nil
                    loadID = UUID()
                    olderLoadID = nil; isLoadingOlder = false
                    recoveryID = UUID(); recoveryTask?.cancel(); recoveryTask = nil
                    isLoading = true
                    let identity = loadID
                    Task {
                        guard self.loadID == identity, self.selectedTaskID == task.id else { return }
                        await self.selectTask(task.id, navigating: false)
                    }
                } else {
                    selectedProjectID = section == "chats" ? allProjects.first(where: { $0.raw["kind"].string == "casual" })?.id : nil
                    newTask()
                    selectedSection = section
                }
            }
        }
        recordNavigation()
    }

    private func recordNavigation(addingHistory: Bool = true) {
        let entry = Navigation(section: selectedSection, project: selectedProjectID, task: selectedTaskID,
            extensionID: selectedSection == "extension-panel" ? selectedExtensionID : nil,
            panelID: selectedSection == "extension-panel" ? selectedPanelID : nil)
        if addingHistory, (!navigationHistory.indices.contains(navigationIndex) || navigationHistory[navigationIndex] != entry) {
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
        navigationID = UUID()
        selectedProjectID = entry.project
        selectedSection = entry.section
        selectedExtensionID = entry.extensionID
        selectedPanelID = entry.panelID
        if let id = entry.task, tasks.contains(where: { $0.id == id }) {
            if ["project", "chats", "pins"].contains(entry.section) { await selectTask(id, recordHistory: false) }
            else { selectedTaskID = id; recordNavigation(addingHistory: false) }
        } else { newTask(recordHistory: false); selectedSection = entry.section; recordNavigation(addingHistory: false) }
    }

    func navigateTask(_ delta: Int) async {
        guard ["project", "chats", "pins"].contains(selectedSection),
              taskNavigationSection == selectedSection,
              taskNavigationProject == (selectedSection == "project" ? selectedProjectID : nil) else { return }
        let existing = Set(tasks.map(\.id))
        let candidates = taskNavigationIDs.filter { existing.contains($0) }
        guard !candidates.isEmpty else { return }
        let current = candidates.firstIndex { $0 == selectedTaskID }
        let index = current.map { (($0 + delta) % candidates.count + candidates.count) % candidates.count }
            ?? (delta < 0 ? candidates.count - 1 : 0)
        await selectTask(candidates[index])
    }

    func registerTaskNavigation(_ ids: [String], section: String, projectID: String?) {
        taskNavigationIDs = ids
        taskNavigationSection = section
        taskNavigationProject = projectID
    }

    func selectExtensionPanel(extensionID: String, panelID: String) {
        navigationID = UUID()
        selectedExtensionID = extensionID; selectedPanelID = panelID; selectedSection = "extension-panel"
        recordNavigation()
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
            let rawQuery = try NativeHostProjection.rawQuery(query, host: host)
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
        let revision = localEventRevision
        do {
            let snapshot = try await client.snapshot()
            guard localEventRevision == revision else { return }
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
        for host in remoteNavigationPreferences.keys.sorted() {
            let remote = remoteNavigationPreferences[host] ?? .null
            for key in arrays { result[key] = .array((result[key] ?? .null).array + remote[key].array) }
            for key in maps {
                result[key] = .object((result[key] ?? .null).fields.merging(remote[key].fields) { _, remote in remote })
            }
        }
        let projectIDs = Set(projects.map(\.id))
        let order = (result["workspace_order"] ?? .null).array.map(\.string).filter { projectIDs.contains($0) } + projects.map(\.id)
        result["workspace_order"] = .array(NativeProjectOrder.interleave(authoritative: order, slots: projectOrderSlots).map(JSON.string))
        return .object(result)
    }

    func updateNavigationPreferences(_ patch: JSON, hostID: String?) async throws {
        var fields = patch.fields
        if let order = fields["workspace_order"] {
            projectOrderSlots = NativeProjectOrder.updatingSlots(previous: projectOrderSlots,
                visibleOrder: order.array.map(\.string), availableHosts: Set(remoteSnapshots.keys).union(["local"]))
            if client is DaemonClient { UserDefaults.standard.set(projectOrderSlots, forKey: "falcondeck.native.projectOrderSlots") }
        }
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
                self.refreshRemoteMetadata(hostID: hostID)
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
        let navigation = navigationID, host = selectedHostID
        do {
            let result = try await request("/api/chats", method: "POST", hostID: host)
            let project = Project(result["workspace"] == .null ? result : result["workspace"])
            if !project.id.isEmpty {
                allProjects.removeAll { $0.id == project.id }; allProjects.append(project)
            }
            if !result["thread"]["id"].string.isEmpty {
                upsertTask(result["thread"])
                guard navigationID == navigation else { return }
                selectedProjectID = project.id
                await selectTask(result["thread"]["id"].string)
            } else {
                guard navigationID == navigation else { return }
                selectedProjectID = project.id; newTask()
            }
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
        let navigation = navigationID
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
                if navigationID == navigation, draftKey == submission.sourceKey {
                    // New edits follow the still-selected project composer into its created task.
                    drafts[created.id] = drafts.removeValue(forKey: submission.sourceKey)
                    composerPayloads[created.id] = composerPayloads.removeValue(forKey: submission.sourceKey)
                    selectedTaskID = created.id; transcript = Transcript(); loadedTaskID = created.id
                    recordNavigation()
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
        connectionID = UUID(); loadID = UUID(); navigationID = UUID(); recoveryID = UUID()
        NativeAudioPlayback.shared.stop()
        NativeAudioPlayback.shared.stopRealtime()
        await client.disconnect()
        if client is DaemonClient {
            for host in NativeHostManager.shared.hosts { await NativeHostManager.shared.disconnect(hostID: host.id) }
        }
        try? await persistInputState()
    }

    func markSelectedTaskRead() {
        guard readVisibility(),
              ["project", "chats", "pins"].contains(selectedSection), let task = selectedTask,
              !isLoading, loadedTaskID == task.id else { return }
        let sequence = task.raw["attention"]["last_agent_activity_seq"].int
        guard sequence > task.raw["attention"]["last_read_seq"].int,
              sequence > max(lastReadSequences[task.id] ?? -1, pendingReads[task.id]?.sequence ?? -1) else { return }
        let operation = UUID()
        pendingReads[task.id] = PendingRead(id: operation, sequence: sequence)
        let navigation = navigationID, detailIdentity = loadID
        Task {
            defer { if pendingReads[task.id]?.id == operation { pendingReads.removeValue(forKey: task.id) } }
            guard selectedTaskID == task.id, loadID == detailIdentity, navigationID == navigation,
                  ["project", "chats", "pins"].contains(selectedSection), readVisibility() else { return }
            do {
                if NativeHostManager.split(task.projectID).hostID == nil {
                    try await client.markRead(projectID: task.projectID, threadID: task.id, readSeq: sequence)
                } else {
                    _ = try await request(["api", "workspaces", task.projectID, "threads", task.id, "read"], method: "POST", body: .object(["read_seq": .number(Double(sequence))]))
                }
                if pendingReads[task.id]?.id == operation { lastReadSequences[task.id] = max(lastReadSequences[task.id] ?? -1, sequence) }
            } catch { /* Leave the watermark retryable when delivery fails. */ }
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
            refreshRemoteMetadata(hostID: update.hostID)
            preferenceRevision[update.hostID, default: 0] &+= 1
            if client is DaemonClient { NativePlatform.shared.handle(.object(["event": .object(["type": .string("snapshot"), "snapshot": value])]), hostID: update.hostID) }
            rebuildIndexes()
            recoverRemoteSelection(hostID: update.hostID)
        case .rebase(let values):
            // These envelopes already reached the live transcript while a fresh
            // snapshot was loading. Replay only their index metadata.
            for value in values {
                remoteSnapshots[update.hostID] = NativeHostProjection.reduce(remoteSnapshots[update.hostID] ?? .object([:]), envelope: value)
            }
            refreshRemoteMetadata(hostID: update.hostID)
            rebuildIndexes()
        case .events(let values):
            for value in values {
                remoteSnapshots[update.hostID] = NativeHostProjection.reduce(remoteSnapshots[update.hostID] ?? .object([:]), envelope: value)
                if client is DaemonClient { NativePlatform.shared.handle(value, hostID: update.hostID) }
                let type = value["event"]["type"].string
                if ["snapshot", "preferences-updated", "extension-catalog-updated", "extension-view-updated"].contains(type) {
                    refreshRemoteMetadata(hostID: update.hostID)
                }
                if type == "snapshot" {
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
            refreshRemoteMetadata(hostID: update.hostID)
            remoteStatuses.removeValue(forKey: update.hostID)
            rebuildIndexes()
        case .status(let status, _): remoteStatuses[update.hostID] = status; eventRevision &+= 1
        }
    }

    private func refreshRemoteMetadata(hostID: String) {
        guard let snapshot = remoteSnapshots[hostID] else {
            remoteNavigationPreferences.removeValue(forKey: hostID)
            remoteExtensions.removeValue(forKey: hostID)
            return
        }
        let preferences = NativeHostProjection.preferences(snapshot["preferences"], host: hostID)
        if remoteNavigationPreferences[hostID] != preferences { remoteNavigationPreferences[hostID] = preferences }
        let extensions = NativeHostProjection.extensions(snapshot["extensions"], host: hostID)
        if remoteExtensions[hostID] != extensions { remoteExtensions[hostID] = extensions }
    }

    private func rebuildIndexes() {
        allProjects = localSnapshot["workspaces"].array.map(Project.init)
        projects = allProjects.filter { !["scratch", "casual"].contains($0.raw["kind"].string) }
        tasks = localSnapshot["threads"].array.map(AgentTask.init)
        requests = localSnapshot["interactive_requests"].array
        appendRemoteIndexes()
        if let id = selectedProjectID, !allProjects.contains(where: { $0.id == id }), !isAwaitingRemoteSelection {
            selectedProjectID = projects.first?.id
            newTask()
        } else if let id = selectedTaskID, !tasks.contains(where: { $0.id == id }), !isAwaitingRemoteSelection { newTask() }
        eventRevision &+= 1
    }

    private func recoverRemoteSelection(hostID: String) {
        guard selectedHostID == hostID, let taskID = selectedTaskID, !isLoading else { return }
        let navigation = loadID
        Task {
            guard loadID == navigation, selectedTaskID == taskID, selectedHostID == hostID else { return }
            await selectTask(taskID, navigating: false)
        }
    }

    private var isAwaitingRemoteSelection: Bool {
        guard let host = selectedHostID, remoteSnapshots[host] == nil else { return false }
        return remoteStatuses[host] != nil || (client is DaemonClient && NativeHostManager.shared.hosts.contains { $0.id == host })
    }
}
