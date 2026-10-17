import Foundation
import Observation

enum Destination: Hashable {
    case projects, activity, task(String)
}

@MainActor @Observable
final class ChatSession {
    var transcript = Transcript()
    var draft = ""
    var modelID = ""
    var effort = ""
    var loading = false
    var loaded = false
    var sending = false
    var stopping = false
    var hasOlder = false
    var oldestID: String?
    var error: String?
    var notice: String?
    var bufferedEvents: [JSON] = []
    var loadID = UUID()
}

@MainActor @Observable
final class AppModel {
    let relay = RelayClient()
    var projects: [Project] = []
    var tasks: [AgentTask] = [] {
        didSet {
            taskGroups = Dictionary(grouping: tasks, by: \.projectID).mapValues { values in
                values.sorted { $0.pinned != $1.pinned ? $0.pinned : $0.updatedAt > $1.updatedAt }
            }
        }
    }
    private var taskGroups: [String: [AgentTask]] = [:]
    @ObservationIgnored private var pendingSummaries: [String: JSON] = [:]
    @ObservationIgnored private var summaryFlush: Task<Void, Never>?
    var connected = false
    var status = "Not connected"
    var error: String?
    var demo = false
    var hasSession = false
    var busy = false
    var refreshedAt: Date?
    var showConnection = false
    var pairingText = ""
    var selection: Destination? = .projects
    var showNewTask = false
    var newTaskProjectID: String?
    var newTaskFolderID: String?
    var preferences = JSON.object([:])
    var requests: [JSON] = []
    var chats: [String: ChatSession] = [:]
    private var lastEventSeq = 0
    private var observation: Task<Void, Never>?

    func start() async {
        guard observation == nil else { return }
        let events = await relay.events()
        observation = Task { [weak self] in
            for await event in events {
                guard let self else { return }
                switch event {
                case .status(let text, let online):
                    if !self.demo { self.status = text; self.connected = online }
                    if text == "Connecting…" { self.lastEventSeq = 0 }
                case .snapshot(let value):
                    self.summaryFlush?.cancel(); self.summaryFlush = nil; self.pendingSummaries = [:]
                    self.projects = value["workspaces"].array.filter { $0["kind"].string != "scratch" }.map(Project.init)
                    self.tasks = value["threads"].array.filter { !$0["is_archived"].bool }.map(AgentTask.init)
                    self.preferences = value["preferences"]
                    self.requests = value["interactive_requests"].array
                    self.refreshedAt = .now; self.error = nil; self.demo = false
                case .events(let events):
                    for event in events { self.applyEnvelope(event) }
                case .rebase(let events):
                    for event in events { self.applyEnvelope(event, rebase: true) }
                case .error(let message): self.error = message; self.connected = false
                }
            }
        }
        if ProcessInfo.processInfo.arguments.contains("--demo") { await useDemo(); return }
        do { hasSession = try await relay.restore() }
        catch { self.error = error.localizedDescription; hasSession = (try? SessionVault.load()) != nil }
    }

    func pair(relayURL: String) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let input = try PairingInput(text: pairingText, relay: relayURL)
            try await relay.pair(input)
            hasSession = true; demo = false; projects = []; tasks = []; pairingText = ""
            chats = [:]; requests = []; preferences = .object([:]); selection = .projects
            showConnection = false
        } catch { self.error = error.localizedDescription }
    }

    func reconnect() async {
        guard hasSession, !busy, !demo else { return }
        busy = true; error = nil
        defer { busy = false }
        do { hasSession = try await relay.restore() }
        catch { self.error = error.localizedDescription }
    }
    func refresh() async {
        if demo { return }
        if !connected { await reconnect() }
        else { await relay.refresh() }
        if case .task(let id) = selection, let task = tasks.first(where: { $0.id == id }) { await loadChat(task) }
    }
    func forget() async {
        do {
            try await relay.disconnect(forget: true)
            projects = []; tasks = []; demo = false; hasSession = false; refreshedAt = nil; error = nil
            chats = [:]; preferences = .object([:]); requests = []; selection = .projects; lastEventSeq = 0
        } catch { self.error = error.localizedDescription }
    }
    func useDemo() async {
        try? await relay.disconnect()
        demo = true; connected = false; error = nil; status = "Demo workspace"
        projects = Demo.projects; tasks = Demo.tasks; refreshedAt = nil
        chats = [:]; requests = []; preferences = Demo.preferences; selection = .projects
    }
    func tasks(in project: Project) -> [AgentTask] {
        taskGroups[project.id] ?? []
    }
    var sortedProjects: [Project] {
        let order = preferences["workspace_order"].array.map(\.string)
        let running = Set(tasks.filter(\.running).map(\.projectID))
        return projects.sorted { lhs, rhs in
            let leftOrder = order.firstIndex(of: lhs.id) ?? Int.max
            let rightOrder = order.firstIndex(of: rhs.id) ?? Int.max
            if leftOrder != rightOrder { return leftOrder < rightOrder }
            let left = running.contains(lhs.id)
            let right = running.contains(rhs.id)
            if left != right { return left }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    var folders: [ProjectFolder] { preferences["project_folders"].array.map { ProjectFolder(raw: $0) } }
    func chat(for task: AgentTask) -> ChatSession {
        if let value = chats[task.id] { return value }
        let value = ChatSession(); value.modelID = task.modelID; value.effort = task.effort
        chats[task.id] = value
        return value
    }

    func loadChat(_ task: AgentTask, older: Bool = false) async {
        let chat = chat(for: task)
        guard !chat.loading else { return }
        chat.loading = true; chat.error = nil; chat.bufferedEvents = []
        let loadID = UUID(); chat.loadID = loadID
        defer { if chat.loadID == loadID { chat.loading = false } }
        if demo {
            if !chat.loaded { chat.transcript.items = Demo.messages }
            chat.loaded = true; return
        }
        do {
            let page = try await relay.detail(task: task, before: older ? chat.oldestID : nil)
            guard chat.loadID == loadID, !Task.isCancelled else { return }
            let items = page["items"].array.map(Message.init)
            if older { chat.transcript.prepend(items) }
            else {
                // Preserve unacknowledged local rows, then replay events that
                // arrived during this authoritative history request.
                let pending = chat.transcript.items.filter { pending in pending.raw["pending"].bool && !items.contains(where: { $0.id == pending.id }) }
                chat.transcript = Transcript(items: items + pending)
            }
            chat.transcript.needsRecovery = false
            for event in chat.bufferedEvents { chat.transcript.apply(event) }
            chat.bufferedEvents = []
            chat.hasOlder = page["has_older"].bool
            chat.oldestID = page["oldest_item_id"].string.nonempty ?? chat.transcript.items.first?.id
            chat.loaded = true
            upsertTask(page["thread"])
        } catch { if chat.loadID == loadID { chat.error = error.localizedDescription } }
    }

    private func upsertTask(_ raw: JSON) {
        guard !raw["id"].string.isEmpty else { return }
        let task = AgentTask(raw)
        if task.raw["is_archived"].bool { tasks.removeAll { $0.id == task.id }; return }
        if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index] = task }
        else { tasks.append(task) }
    }

    private func applyEnvelope(_ envelope: JSON, rebase: Bool = false) {
        guard !demo, let seq = envelope["seq"].optionalInt, rebase || seq > lastEventSeq else { return }
        if !rebase { lastEventSeq = seq }
        let event = envelope["event"], id = envelope["thread_id"].string
        switch event["type"].string {
        case "thread-started", "thread-updated": stageSummary(event["thread"])
        case "workspace-updated":
            let project = Project(event["workspace"])
            if let index = projects.firstIndex(where: { $0.id == project.id }) { projects[index] = project }
            else { projects.append(project) }
        case "preferences-updated": preferences = event["preferences"]
        case "interactive-request":
            let request = event["request"]
            requests.removeAll { $0["request_id"] == request["request_id"] }; requests.append(request)
        case "turn-start", "turn-end":
            if let task = tasks.first(where: { $0.id == id }) {
                let raw = pendingSummaries[id] ?? task.raw
                stageSummary(raw.setting("status", .string(event["type"].string == "turn-start" ? "running" : "idle")))
            }
            if event["type"].string == "turn-end" { requests.removeAll { $0["thread_id"].string == id } }
        case "conversation-item-updated", "conversation-item-added":
            let item = event["item"]
            if item["kind"].string == "interactive_request", item["resolved"].bool {
                requests.removeAll { $0["request_id"] == item["request"]["request_id"] }
            }
        default: break
        }
        if !rebase, let chat = chats[id] {
            if chat.loading && chat.bufferedEvents.count < 2048 { chat.bufferedEvents.append(event) }
            chat.transcript.apply(event)
            if chat.transcript.needsRecovery, !chat.loading, let task = tasks.first(where: { $0.id == id }) {
                Task { await self.loadChat(task) }
            }
        }
    }

    private func stageSummary(_ raw: JSON) {
        let id = raw["id"].string
        guard !id.isEmpty else { return }
        pendingSummaries[id] = raw
        guard summaryFlush == nil else { return }
        // Keep transcript tokens immediate; coalesce sidebar metadata so a
        // busy task doesn't rebuild thousands of sidebar rows per token.
        summaryFlush = Task {
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
            let updates = self.pendingSummaries
            self.pendingSummaries = [:]; self.summaryFlush = nil
            var next = self.tasks
            for (id, raw) in updates {
                if raw["is_archived"].bool { next.removeAll { $0.id == id } }
                else if let index = next.firstIndex(where: { $0.id == id }) { next[index] = AgentTask(raw) }
                else { next.append(AgentTask(raw)) }
            }
            self.tasks = next
        }
    }

    func send(_ task: AgentTask) async {
        let chat = chat(for: task)
        let text = chat.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !chat.sending, demo || connected else { return }
        chat.sending = true; chat.error = nil; chat.notice = nil
        let id = "user-\(UUID().uuidString)"
        let optimistic = Message(.object(["id": .string(id), "kind": .string("user_message"), "text": .string(text), "pending": .bool(true)]))
        if !task.running { chat.transcript.upsert(optimistic) }
        defer { chat.sending = false }
        if demo {
            chat.draft = ""; chat.transcript.upsert(optimistic)
            chat.transcript.upsert(Message(.object(["id": .string("demo-\(UUID())"), "kind": .string("assistant_message"), "text": .string(Demo.markdownReply)])))
            return
        }
        do {
            let response = try await relay.call("turn.start", params: NativeRequest.turn(task: task, text: text, itemID: id, modelID: chat.modelID, effort: chat.effort))
            if response["message"].string == "queued" {
                chat.transcript.items.removeAll { $0.id == id }; chat.notice = "Message queued for the next turn."
            }
            if chat.draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { chat.draft = "" }
        } catch {
            chat.transcript.items.removeAll { $0.id == id && $0.raw["pending"].bool }
            chat.error = "\(error.localizedDescription) Refresh this task before resending if delivery is uncertain."
        }
    }

    func stop(_ task: AgentTask) async {
        let chat = chat(for: task)
        guard !chat.stopping else { return }
        chat.stopping = true; defer { chat.stopping = false }
        do {
            if !demo { _ = try await relay.call("turn.interrupt", params: .object(["workspace_id": .string(task.projectID), "thread_id": .string(task.id)])) }
            upsertTask(task.raw.setting("status", .string("idle")))
        } catch { chat.error = error.localizedDescription }
    }

    func createTask(project: Project, provider: String, modelID: String, folderID: String?) async throws {
        let raw: JSON
        if demo {
            raw = .object(["id": .string("demo-\(UUID())"), "workspace_id": .string(project.id), "title": .string("New task"), "provider": .string(provider), "status": .string("idle")])
        } else {
            var params = JSON.object(["workspace_id": .string(project.id), "provider": .string(provider)])
            if !modelID.isEmpty { params = params.setting("model_id", .string(modelID)) }
            raw = try await relay.call("thread.start", params: params)["thread"]
        }
        upsertTask(raw)
        let task = AgentTask(raw)
        let chat = chat(for: task); chat.loaded = true
        selection = .task(task.id)
        if let folderID {
            do { try await folderMutation(projectID: project.id, action: "move_thread", folderID: folderID, taskID: task.id) }
            catch { self.error = "Task created, but it could not be moved to the folder: \(error.localizedDescription)" }
        }
    }

    func updateTask(_ task: AgentTask, fields: [String: JSON]) async {
        do {
            var params = JSON.object(fields).setting("workspace_id", .string(task.projectID)).setting("thread_id", .string(task.id))
            if demo {
                params = task.raw
                for (key, value) in fields { params = params.setting(key == "pinned" ? "is_pinned" : key == "pinned_in_project" ? "is_pinned_in_project" : key, value) }
                upsertTask(params)
            } else {
                let result = try await relay.call("thread.update", params: params)
                upsertTask(result["thread"] == .null ? result : result["thread"])
            }
        } catch { self.error = error.localizedDescription }
    }

    func archive(_ task: AgentTask) async {
        do {
            if !demo { _ = try await relay.call("thread.archive", params: .object(["workspace_id": .string(task.projectID), "thread_id": .string(task.id)])) }
            tasks.removeAll { $0.id == task.id }; chats.removeValue(forKey: task.id)
            if selection == .task(task.id) { selection = .projects }
        } catch { self.error = error.localizedDescription }
    }

    func folderMutation(projectID: String, action: String, folderID: String? = nil, name: String? = nil, taskID: String? = nil, collapsed: Bool? = nil) async throws {
        var mutation = JSON.object(["workspace_id": .string(projectID), "action": .string(action)])
        if let folderID { mutation = mutation.setting("folder_id", .string(folderID)) }
        else if action == "move_thread" { mutation = mutation.setting("folder_id", .null) }
        if let name { mutation = mutation.setting("name", .string(name)) }
        if let taskID { mutation = mutation.setting("thread_id", .string(taskID)) }
        if let collapsed { mutation = mutation.setting("collapsed", .bool(collapsed)) }
        if demo { applyDemoFolder(mutation); return }
        preferences = try await relay.call("preferences.update", params: .object(["project_folder": mutation]))
    }

    private func applyDemoFolder(_ mutation: JSON) {
        var values = preferences["project_folders"].array
        let id = mutation["folder_id"].string
        switch mutation["action"].string {
        case "create": values.append(mutation.setting("id", .string(UUID().uuidString)).setting("thread_ids", .array([])))
        case "delete": values.removeAll { $0["id"].string == id }
        case "rename", "set_collapsed":
            if let index = values.firstIndex(where: { $0["id"].string == id }) {
                let key = mutation["action"].string == "rename" ? "name" : "collapsed"
                values[index] = values[index].setting(key, mutation[key])
            }
        case "move_thread":
            for index in values.indices {
                var ids = values[index]["thread_ids"].array.filter { $0 != mutation["thread_id"] }
                if values[index]["id"].string == id { ids.append(mutation["thread_id"]) }
                values[index] = values[index].setting("thread_ids", .array(ids))
            }
        default: break
        }
        preferences = preferences.setting("project_folders", .array(values))
    }

    func respond(request: JSON, response: JSON) async throws {
        if !demo {
            _ = try await relay.call("interactive.respond", params: .object(["workspace_id": request["workspace_id"], "request_id": request["request_id"], "response": response]))
        }
        requests.removeAll { $0["request_id"] == request["request_id"] }
    }
}

enum Demo {
    static let preferences = JSON.object(["project_folders": .array([
        .object(["id": .string("native-folder"), "workspace_id": .string("falcondeck"), "name": .string("Native app"), "collapsed": .bool(false), "thread_ids": .array([.string("native"), .string("review")])]),
        .object(["id": .string("reliability-folder"), "workspace_id": .string("falcondeck"), "name": .string("Reliability"), "collapsed": .bool(true), "thread_ids": .array([.string("relay")])])
    ])])
    static let markdownReply = """
    ## A native place for your work

    This is a **local demo reply**. In live mode, this composer sends messages to your agent through the encrypted relay.

    - Native sidebar with projects and folders
    - Live replies, tool activity, and reasoning
    - Selectable Markdown with `inline code`

    ```swift
    struct FalconDeck: View {
        var body: some View {
            Text("Your agents, in focus.")
        }
    }
    ```

    | Experience | Native client |
    | --- | --- |
    | Chat | Streamed replies |
    | Navigation | Projects and folders |
    | Privacy | End-to-end encrypted |

    > Your computer remains the source of truth.

    [FalconDeck](https://falcondeck.com)
    """
    static let projects: [Project] = [
        project("falcondeck", "/Projects/falcondeck"), project("quizgecko", "/Projects/quizgecko"),
        project("lookset", "/Projects/lookset"), project("lucidpic", "/Projects/lucidpic")
    ]
    static let tasks: [AgentTask] = [
        task("native", "falcondeck", "A more native way to work", "codex", "running", "Exploring the little details that make an app feel right at home on iPhone.", pinned: true),
        task("relay", "falcondeck", "Make reconnects feel instant", "claude", "idle", "The relay recovery path now restores a fresh snapshot when history has been pruned."),
        task("review", "falcondeck", "Review the new project sidebar", "codex", "waiting_for_input", "The implementation is ready. There’s one decision to make about the compact layout."),
        task("quiz", "quizgecko", "Bring the study flow to SwiftUI", "claude", "running", "The flashcard transition now follows your gesture with a spring animation."),
        task("voice", "quizgecko", "Polish the voice tutor", "codex", "idle", "The tutor keeps listening while you move between study materials."),
        task("samples", "lookset", "A fresh set of product scenes", "claude", "idle", "Four directions, with consistent lighting and a quieter background."),
        task("images", "lucidpic", "Simplify the image library", "codex", "idle", "The library now groups recent generations into a single collection.")
    ]
    static let messages: [Message] = [
        message("1", "user_message", "Let’s explore a truly native FalconDeck. Keep the core experience simple, but make it feel great on iPhone."),
        message("2", "assistant_message", "I’ve narrowed the pilot down to three things: your projects, the tasks inside them, and the conversations that matter.\n\nThe interface uses **native SwiftUI navigation**, SF Symbols, and glass controls. Project cards open with a zoom transition, and the layout adapts to your text size."),
        message("3", "user_message", "Can it talk to the real relay too?"),
        message("4", "assistant_message", markdownReply)
    ]
    private static func project(_ id: String, _ path: String) -> Project {
        Project(.object(["id": .string(id), "path": .string(path), "status": .string("connected")]))
    }
    private static func task(_ id: String, _ project: String, _ title: String, _ provider: String, _ status: String, _ preview: String, pinned: Bool = false) -> AgentTask {
        AgentTask(.object(["id": .string(id), "workspace_id": .string(project), "title": .string(title), "provider": .string(provider),
                           "status": .string(status), "last_message_preview": .string(preview), "updated_at": .string("2026-10-17T07:00:00Z"), "is_pinned": .bool(pinned)]))
    }
    private static func message(_ id: String, _ kind: String, _ text: String) -> Message {
        Message(.object(["id": .string(id), "kind": .string(kind), "text": .string(text)]))
    }
}
