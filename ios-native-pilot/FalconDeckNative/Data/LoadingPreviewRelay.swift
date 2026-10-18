#if DEBUG
import Foundation

/// A compact index with unloaded casual workspaces and a deliberately slow
/// history response. Previews never read a pairing or contact a real computer.
actor LoadingPreviewRelay: RelayServing {
    static let token = "loading-preview"
    static let task = AgentTask(Demo.tasks[0].raw.setting("status", .string("idle")).setting("attention", .object(["unread": .bool(true), "last_agent_activity_seq": .number(1)])))
    static let projects = [Demo.projects[0]] + (0..<12).map { index in
        Project(Demo.projects.last!.raw.setting("id", .string("chat-\(index)")))
    }
    static let counts = JSON.object(Dictionary(uniqueKeysWithValues: projects.map {
        ($0.id, .object(["total": .number($0.id == "falcondeck" ? 3 : 1)]))
    }))
    static let settlingHistory: [Message] = (0..<40).flatMap { index in [
        Message(.object(["id": .string("settle-user-\(index)"), "kind": .string("user_message"), "text": .string("Review change \(index + 1) and keep the existing behavior.")])),
        Message(.object(["id": .string("settle-answer-\(index)"), "kind": .string("assistant_message"), "text": .string(index == 39 ? "Latest response. This should appear in its final position immediately." : "## Change \(index + 1)\n\n" + String(repeating: "The layout should stay steady while the conversation loads. ", count: index % 4 + 1))]))
    ] }
    private var historyRequests = 0
    private var preferences = Demo.preferences
    private let failFirst: Bool
    private var sink: AsyncStream<RelayUpdate>.Continuation?
    private var connectionID = UUID()
    private var modelRequests: [String: Int] = [:]
    private var sequence = 0
    init(failFirst: Bool) { self.failFirst = failFirst }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { sink = $0 } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { self.connectionID = connectionID; return true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) async throws -> JSON {
        historyRequests += 1
        let fails = failFirst && historyRequests == 1
        let settling = ProcessInfo.processInfo.arguments.contains("--loading-preview=settling")
        let delay = settling ? ProcessInfo.processInfo.arguments.contains("--settling-slow") ? 10 : 2 : 5
        try await Task.sleep(for: .seconds(delay))
        if fails { throw PilotError("The preview computer took too long to respond.") }
        return .object(["thread": task.raw, "items": .array((settling ? Self.settlingHistory : Demo.messages).map(\.raw)), "has_older": .bool(false)])
    }
    private func publishWorkspace(_ raw: JSON) {
        sequence += 1
        sink?.yield(.init(connectionID: connectionID, event: .events([.object(["seq": .number(Double(sequence)), "event": .object(["type": .string("workspace-updated"), "workspace": raw])])])))
    }
    func call(_ method: String, params: JSON) async throws -> JSON {
        if method == "provider.hydrate" {
            if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--loading-preview=harness-") }) { return .object(["ok": .bool(true)]) }
            let id = params["workspace_id"].string
            let key = id + ":" + params["provider"].string
            modelRequests[key, default: 0] += 1
            if ProcessInfo.processInfo.arguments.contains("--loading-preview=models-retry"), modelRequests[key] == 1 { throw PilotError("The preview computer couldn't load models.") }
            guard let project = Demo.projects.first(where: { $0.id == id }) else { return .null }
            let current = connectionID
            if ProcessInfo.processInfo.arguments.contains("--loading-preview=models-reconnecting") {
                let empty = project.raw.setting("agents", .array(project.raw["agents"].array.map { $0.setting("models", .array([])) }))
                publishWorkspace(empty.setting("agents", .array(empty["agents"].array.map { $0.setting("models_loading", .bool(true)) })))
                Task {
                    try? await Task.sleep(for: .milliseconds(300))
                    guard current == connectionID else { return }
                    publishWorkspace(empty.setting("status", .string("connecting")).setting("agents", .array(empty["agents"].array.map {
                        $0.setting("models_loading", .bool(false)).setting("account", .object(["status": .string("unknown"), "label": .string("Codex reconnecting")]))
                    })))
                }
            }
            Task {
                try? await Task.sleep(for: .seconds(3))
                guard current == connectionID else { return }
                publishWorkspace(project.raw)
            }
            return .object(["ok": .bool(true)])
        }
        if method == "sync.threads" {
            try await Task.sleep(for: .milliseconds(100))
            let id = params["workspace_id"].string
            let rows = id == "falcondeck" ? Demo.tasks.filter { $0.projectID == id }.map(\.raw) : [
                Demo.tasks.last!.raw.setting("id", .string("task-\(id)")).setting("workspace_id", .string(id))
                    .setting("title", .string("Conversation \(id.dropFirst(5))"))
            ]
            return .object(["token": .string(Self.token), "workspace_id": .string(id), "threads": .array(rows), "next_cursor": .null])
        }
        if method == "preferences.update" {
            try await Task.sleep(for: .milliseconds(600))
            let mutation = params["project_folder"]
            let folders = preferences["project_folders"].array.map {
                $0["id"] == mutation["folder_id"] ? $0.setting("collapsed", mutation["collapsed"]) : $0
            }
            preferences = preferences.setting("project_folders", .array(folders))
            return preferences
        }
        if method == "speech.transcribe" { return .object(["text": .string("A clear native transcript.")]) }
        if method == "thread.mark_read" {
            let task = ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--loading-preview=harness-") }) ? HarnessPreview.task : Self.task
            return .object(["thread": task.raw.setting("attention", .object(["unread": .bool(false), "last_agent_activity_seq": .number(1), "last_read_seq": .number(1)]))])
        }
        return .null
    }
}
#endif
