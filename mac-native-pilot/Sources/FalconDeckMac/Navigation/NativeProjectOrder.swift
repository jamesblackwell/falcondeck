/// Each daemon owns its project order; this client only remembers how the
/// computers' rows interleave. A stale project ID still reserves its host's
/// slot, so closed projects or temporarily absent computers do not reset it.
enum NativeProjectOrder {
    static func interleave(authoritative: [String], slots: [String]) -> [String] {
        var seen: Set<String> = []
        let current = authoritative.filter { !$0.isEmpty && seen.insert($0).inserted }
        var queues: [String: [String]] = [:]
        for id in current { queues[host(id), default: []].append(id) }

        var next: [String: Int] = [:]
        var usedSlots: Set<String> = []
        var included: Set<String> = []
        var result: [String] = []
        for slot in slots where !slot.isEmpty && usedSlots.insert(slot).inserted {
            let computer = host(slot), index = next[computer, default: 0]
            guard let queue = queues[computer], index < queue.count else { continue }
            let id = queue[index]
            result.append(id)
            included.insert(id)
            next[computer] = index + 1
        }
        // Newly discovered hosts and rows have no saved slot yet. Keep their
        // authoritative relative order until the user places them explicitly.
        result.append(contentsOf: current.filter { !included.contains($0) })
        return result
    }

    /// A reorder only describes the computers currently visible to the client.
    /// Keep unavailable computers' old slots until they reconnect; slots from
    /// available computers may be replaced or retired by the new order.
    static func updatingSlots(previous: [String], visibleOrder: [String], availableHosts: Set<String>) -> [String] {
        var seen: Set<String> = []
        let old = previous.filter { !$0.isEmpty && seen.insert($0).inserted }
        let reserved = Set(old.filter { !availableHosts.contains(host($0)) })
        seen = reserved
        let visible = visibleOrder.filter { !$0.isEmpty && seen.insert($0).inserted }

        var result: [String] = []
        var next = 0
        for slot in old {
            if reserved.contains(slot) {
                result.append(slot)
            } else if next < visible.count {
                result.append(visible[next])
                next += 1
            }
        }
        result.append(contentsOf: visible.dropFirst(next))
        return result
    }

    private static func host(_ id: String) -> String {
        NativeHostManager.split(id).hostID ?? "local"
    }
}
