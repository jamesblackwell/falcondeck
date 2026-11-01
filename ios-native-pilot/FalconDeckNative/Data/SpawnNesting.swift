import Foundation

/// Mirrors `nestSpawnedThreads` in client-core: agent-spawned tasks follow the
/// task that spawned them, and a family keeps its best-placed member's rank so
/// the chosen sort still decides where it lands. A child whose parent is not in
/// the same list keeps its own top-level place.
enum SpawnNesting {
    static let maxDepth = 3

    static func nest(_ tasks: [AgentTask]) -> (tasks: [AgentTask], depth: [String: Int]) {
        var byID: [String: AgentTask] = [:], rank: [String: Int] = [:]
        for (index, task) in tasks.enumerated() where byID[task.id] == nil { byID[task.id] = task; rank[task.id] = index }
        var children: [String: [AgentTask]] = [:], nested = Set<String>()
        for task in tasks {
            guard let parent = parentID(task), byID[parent] != nil else { continue }
            nested.insert(task.id); children[parent, default: []].append(task)
        }
        guard !children.isEmpty else { return (tasks, [:]) }

        var familyRank: [String: Int] = [:]
        func rankOfFamily(_ task: AgentTask) -> Int {
            if let cached = familyRank[task.id] { return cached }
            let own = rank[task.id] ?? tasks.count
            // Recorded before recursing so a spawn cycle settles instead of looping.
            familyRank[task.id] = own
            var best = own
            for child in children[task.id] ?? [] { best = min(best, rankOfFamily(child)) }
            familyRank[task.id] = best
            return best
        }
        // Rank first: the comparator must not read `children` while it is being sorted.
        for task in tasks { _ = rankOfFamily(task) }
        children = children.mapValues { $0.sorted { (familyRank[$0.id] ?? tasks.count) < (familyRank[$1.id] ?? tasks.count) } }

        var ordered: [AgentTask] = [], depth: [String: Int] = [:], emitted = Set<String>()
        func emit(_ task: AgentTask, _ level: Int) {
            guard emitted.insert(task.id).inserted else { return }
            ordered.append(task)
            if level > 0 { depth[task.id] = level }
            for child in children[task.id] ?? [] { emit(child, min(level + 1, maxDepth)) }
        }
        for root in tasks.filter({ !nested.contains($0.id) }).sorted(by: { rankOfFamily($0) < rankOfFamily($1) }) { emit(root, 0) }
        // Only a spawn cycle is unreachable from a root; keep its members visible.
        if ordered.count < tasks.count { for task in tasks { emit(task, 0) } }
        return (ordered, depth)
    }

    private static func parentID(_ task: AgentTask) -> String? {
        let origin = task.raw["origin"]
        guard origin["kind"].string == "agent_spawn" else { return nil }
        let parent = origin["parent_thread_id"].string
        return parent.isEmpty || parent == task.id ? nil : parent
    }
}
