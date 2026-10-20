import Foundation

/// Build the sidebar's counts together rather than rescanning every task for
/// each project and resolving its workspace again for the Chats count.
struct NativeProjectNavigationSummary {
    var chatCount = 0
    var attentionCount = 0
    var projectCounts: [String: Int] = [:]
    var runningProjectIDs: Set<String> = []
    var pinCandidates: [AgentTask] = []

    init(projects: [Project], tasks: [AgentTask]) {
        let casualIDs = Set(projects.filter { $0.raw["kind"].string == "casual" }.map(\.id))
        for task in tasks where !task.raw["is_archived"].bool {
            let projectID = task.projectID
            projectCounts[projectID, default: 0] += 1
            if task.running { runningProjectIDs.insert(projectID) }
            if task.needsAttention { attentionCount += 1 }
            if task.pinned { pinCandidates.append(task) }
            else if casualIDs.contains(projectID) { chatCount += 1 }
        }
    }
}
