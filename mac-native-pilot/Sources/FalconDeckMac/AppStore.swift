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
}

extension DaemonClient: DaemonServing {}

@MainActor @Observable final class AppStore {
    var projects: [Project] = []
    var tasks: [AgentTask] = []
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
    private var requests: [JSON] = []
    @ObservationIgnored private let client: any DaemonServing
    @ObservationIgnored private var connectionTask: Task<Void, Never>?
    @ObservationIgnored private var loadID = UUID()
    @ObservationIgnored private var connectionID = UUID()
    @ObservationIgnored private var bufferedEvents: [JSON] = []
    @ObservationIgnored private var bufferedOverflow = false
    @ObservationIgnored private var recoveryTask: Task<Void, Never>?

    init(client: any DaemonServing = DaemonClient()) { self.client = client }

    var messages: [Message] { transcript.items }
    var selectedProject: Project? { projects.first { $0.id == selectedProjectID } }
    var selectedTask: AgentTask? { tasks.first { $0.id == selectedTaskID } }
    var isRunning: Bool { selectedTask?.status == "running" }
    var pendingRequests: [JSON] { requests.filter { $0["thread_id"].string == selectedTaskID } }
    var availableProviders: [String] {
        let offered = selectedProject?.raw["agents"].array.map { $0["provider"].string }.filter { !$0.isEmpty } ?? []
        return offered.isEmpty ? ["codex", "claude"] : offered
    }
    private var draftKey: String { selectedTaskID ?? "draft:\(selectedProjectID ?? "none")" }
    var draft: String {
        get { drafts[draftKey, default: ""] }
        set { drafts[draftKey] = newValue }
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
                    self.errorMessage = "Open FalconDeck to connect to its local daemon. \(error.localizedDescription)"
                    await self.client.disconnect()
                    attempt = min(attempt + 1, 5)
                    do { try await Task.sleep(for: .seconds(min(pow(2.0, Double(attempt - 1)), 15))) }
                    catch { return }
                }
            }
        }
    }

    func selectProject(_ id: String) {
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
    }

    func selectTask(_ id: String) async {
        guard let task = tasks.first(where: { $0.id == id }) else { return }
        let identity = UUID()
        loadID = identity
        selectedTaskID = id
        selectedProjectID = task.projectID
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
            }
        }
        do {
            let detail = try await client.threadDetail(projectID: task.projectID, threadID: id, before: nil)
            guard loadID == identity, selectedTaskID == id else { return }
            transcript = Transcript(items: detail["items"].array.map(Message.init))
            hasOlder = detail["has_older"].bool
            upsertTask(detail["thread"])
            for event in bufferedEvents { transcript.apply(event) }
            if bufferedOverflow { transcript.needsRecovery = true }
            bufferedEvents = []
            errorMessage = nil
            Task { try? await client.markRead(projectID: task.projectID, threadID: id, readSeq: task.raw["attention"]["last_agent_activity_seq"].int) }
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
            let detail = try await client.threadDetail(projectID: task.projectID, threadID: task.id, before: before)
            guard loadID == identity else { return }
            transcript.prepend(detail["items"].array.map(Message.init))
            hasOlder = detail["has_older"].bool
        } catch { if loadID == identity { errorMessage = error.localizedDescription } }
    }

    func openProject(path: String) async {
        do {
            let project = try await client.connectProject(path: path)
            if !projects.contains(where: { $0.id == project.id }) { projects.append(project) }
            selectProject(project.id)
        } catch { errorMessage = error.localizedDescription }
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, isConnected, !isSending, let projectID = selectedProjectID else { return }
        let key = draftKey, original = draft, originalTaskID = selectedTaskID, chosenProvider = provider
        let navigation = loadID
        var submissionKey = key
        var createdTaskID: String?
        isSending = true
        errorMessage = nil
        defer { isSending = false }
        do {
            let task: AgentTask
            if let originalTaskID, let existing = tasks.first(where: { $0.id == originalTaskID }) { task = existing }
            else {
                task = try await client.startThread(projectID: projectID, provider: chosenProvider, modelID: nil)
                createdTaskID = task.id
                upsertTask(task.raw)
                if draftKey == key, loadID == navigation {
                    // Input typed while creation was in flight follows its composer into the real task.
                    drafts[task.id] = drafts.removeValue(forKey: key)
                    submissionKey = task.id
                    selectedTaskID = task.id
                    transcript = Transcript()
                }
            }
            _ = try await client.sendTurn(projectID: task.projectID, threadID: task.id, text: text, userItemID: "user-\(UUID().uuidString.lowercased())")
            if drafts[submissionKey] == original { drafts.removeValue(forKey: submissionKey) }
        } catch {
            // A lost response does not prove rejection. Keep the input and never retry a mutation automatically.
            if let id = createdTaskID, drafts[id, default: ""].isEmpty { drafts[id] = original }
            errorMessage = "Send wasn’t confirmed. Check the task before sending again. \(error.localizedDescription)"
        }
    }

    func interrupt() async {
        guard let task = selectedTask else { return }
        do { try await client.interrupt(projectID: task.projectID, threadID: task.id) }
        catch { errorMessage = error.localizedDescription }
    }

    func respond(request: JSON, response: JSON) async throws {
        try await client.respond(projectID: request["workspace_id"].string, requestID: request["request_id"].string, response: response)
        requests.removeAll { $0["request_id"] == request["request_id"] }
    }

    func applyEnvelope(_ envelope: JSON) {
        let event = envelope["event"], taskID = envelope["thread_id"].string
        switch event["type"].string {
        case "snapshot":
            let snapshot = event["snapshot"]
            projects = snapshot["workspaces"].array.filter { !["scratch", "casual"].contains($0["kind"].string) }.map(Project.init)
            tasks = snapshot["threads"].array.filter { !$0["is_archived"].bool }.map(AgentTask.init)
            requests = snapshot["interactive_requests"].array
            if !projects.contains(where: { $0.id == selectedProjectID }) {
                let projectIDs = Set(projects.map(\.id))
                selectedProjectID = tasks.filter { projectIDs.contains($0.projectID) }.max { $0.updatedAt < $1.updatedAt }?.projectID ?? projects.first?.id
                newTask()
            }
            if let id = selectedTaskID, !tasks.contains(where: { $0.id == id }) { newTask() }
        case "thread-started", "thread-updated": upsertTask(event["thread"])
        case "workspace-updated":
            let project = Project(event["workspace"])
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
        case "turn-end": requests.removeAll { $0["thread_id"].string == taskID }
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
}
