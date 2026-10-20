import Foundation

/// A live work queue promotes new work immediately, while reading a result
/// must not move the row out from under the user's pointer.
struct NativeTaskNavigationOrder {
    private struct Priority { var bucket: Int; let order: Int }
    private struct Recency { let key: String; let running: Bool }
    private var priority: [String: Priority] = [:]
    private var recency: [String: Recency] = [:]
    private var mode: String?
    private var scope: String?
    private var nextArrival = -1

    mutating func ordered(_ tasks: [AgentTask], mode: String, scope: String) -> [String] {
        let entering = self.mode != mode || self.scope != scope
        if entering {
            priority = [:]; recency = [:]; nextArrival = -1
            self.mode = mode; self.scope = scope
        }
        let live = Set(tasks.map(\.id))
        priority = priority.filter { live.contains($0.key) }
        recency = recency.filter { live.contains($0.key) }

        if mode == "alphabetical" {
            return tasks.sorted {
                let comparison = $0.title.localizedStandardCompare($1.title)
                return comparison == .orderedSame ? $0.id < $1.id : comparison == .orderedAscending
            }.map(\.id)
        }
        if mode == "priority" {
            let sorted = tasks.sorted {
                let left = Self.rank($0), right = Self.rank($1)
                return left == right ? Self.moreRecent($0, $1) : left < right
            }
            if entering {
                for (index, task) in sorted.enumerated() { priority[task.id] = Priority(bucket: Self.rank(task), order: index) }
            } else {
                let arrivals = sorted.filter { priority[$0.id] == nil }
                var order = nextArrival - arrivals.count + 1
                for task in arrivals {
                    priority[task.id] = Priority(bucket: Self.rank(task), order: order)
                    order += 1
                }
                nextArrival -= arrivals.count
                for task in tasks {
                    if var current = priority[task.id], Self.rank(task) < current.bucket {
                        current.bucket = Self.rank(task); priority[task.id] = current
                    }
                }
            }
            return tasks.sorted {
                let left = priority[$0.id]!, right = priority[$1.id]!
                if left.bucket != right.bucket { return left.bucket < right.bucket }
                return left.order == right.order ? $0.id < $1.id : left.order < right.order
            }.map(\.id)
        }
        for task in tasks {
            if let current = recency[task.id], current.running && task.running { continue }
            recency[task.id] = Recency(key: task.updatedAt, running: task.running)
        }
        return tasks.sorted {
            let left = recency[$0.id]?.key ?? "", right = recency[$1.id]?.key ?? ""
            return left == right ? $0.id < $1.id : left > right
        }.map(\.id)
    }

    static func rank(_ task: AgentTask) -> Int {
        if task.awaitingInput { return 0 }
        if task.status == "error" && task.unread { return 1 }
        if task.status == "idle" && task.unread { return 2 }
        return task.running ? 3 : 4
    }

    private static func moreRecent(_ lhs: AgentTask, _ rhs: AgentTask) -> Bool {
        lhs.updatedAt == rhs.updatedAt ? lhs.id < rhs.id : lhs.updatedAt > rhs.updatedAt
    }
}
