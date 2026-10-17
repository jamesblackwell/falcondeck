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
    private var historyRequests = 0
    private var preferences = Demo.preferences
    private let failFirst: Bool
    init(failFirst: Bool) { self.failFirst = failFirst }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) async throws -> JSON {
        historyRequests += 1
        let fails = failFirst && historyRequests == 1
        try await Task.sleep(for: .seconds(5))
        if fails { throw PilotError("The preview computer took too long to respond.") }
        return .object(["thread": task.raw, "items": .array(Demo.messages.map(\.raw)), "has_older": .bool(false)])
    }
    func call(_ method: String, params: JSON) async throws -> JSON {
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
        if method == "thread.mark_read" {
            return .object(["thread": Self.task.raw.setting("attention", .object(["unread": .bool(false), "last_agent_activity_seq": .number(1), "last_read_seq": .number(1)]))])
        }
        return .null
    }
}
#endif
