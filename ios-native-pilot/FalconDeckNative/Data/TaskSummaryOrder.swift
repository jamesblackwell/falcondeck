import Foundation

enum TaskSummaryOrder {
    static func isStale(_ next: JSON, comparedTo current: JSON) -> Bool {
        guard let old = AutomationDraft.parseDate(current["updated_at"].string), let new = AutomationDraft.parseDate(next["updated_at"].string) else { return false }
        if new < old { return true }
        let terminal = ["idle", "error"].contains(current["status"].string)
        return new == old && terminal && !["idle", "error"].contains(next["status"].string)
    }
}

@MainActor extension AppModel {
    func task(_ id: String) -> AgentTask? { tasks.first { $0.id == id } ?? archivedTasks.first { $0.id == id } }
    func openTask(_ id: String) async {
        // A cached destination also supersedes an older lookup still in flight.
        let request = UUID()
        detailRequestID = request
        if task(id) != nil { selection = .task(id); return }
        guard connected, !demo else { error = "Connect to your computer to open this task."; return }
        let current = connectionID, content = detailContentID
        do {
            let snapshot = try await relay.call("snapshot.current", params: .object(["include_archived_threads": .bool(true), "include_thread_plans": .bool(false), "include_thread_diffs": .bool(false), "include_agent_skills": .bool(false), "include_workspace_skills": .bool(false)]))
            guard current == connectionID, request == detailRequestID, content == detailContentID else { return }
            guard let raw = snapshot["threads"].array.first(where: { $0["id"].string == id }) else { throw PilotError("This task is no longer available on your computer.") }
            upsertTask(raw); selection = .task(id)
        } catch {
            if current == connectionID, request == detailRequestID, content == detailContentID { self.error = error.localizedDescription }
        }
    }
}
