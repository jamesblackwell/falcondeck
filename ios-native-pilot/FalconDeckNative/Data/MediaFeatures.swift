import Foundation

@MainActor extension AppModel {
    func fullItem(_ task: AgentTask, itemID: String) async throws -> JSON {
        let current = connectionID
        let key = "\(current):\(task.id):\(itemID)"
        if let cached = itemCache[key] { return cached }
        if let load = itemLoads[key] {
            let result = try await load.task.value
            guard current == connectionID else { throw CancellationError() }
            return result
        }
        let relay = relay, gate = mediaGate
        let load = Task {
            await gate.acquire()
            do {
                guard current == self.connectionID else { throw CancellationError() }
                let value = try await relay.call("thread.item", params: .object(["workspace_id": .string(task.projectID), "thread_id": .string(task.id), "item_id": .string(itemID)]))
                await gate.release(); return value
            } catch { await gate.release(); throw error }
        }
        let loadID = UUID()
        itemLoads[key] = (loadID, load)
        defer { if itemLoads[key]?.id == loadID { itemLoads.removeValue(forKey: key) } }
        let result = try await load.value
        guard current == connectionID else { throw CancellationError() }
        // A live update invalidates even a read that is still in flight. Its
        // old result must neither repopulate the cache nor remove a newer load.
        guard itemLoads[key]?.id == loadID else { return result }
        // Running tools are not immutable; a later tap must fetch their final
        // output rather than retaining the first partial response.
        let item = Message(result)
        if item.streaming || item.kind == "tool_call" && (item.running || result["status"].string == "pending") { return result }
        // Full media is an in-memory display cache, never a conversation store.
        if itemCache.count >= 4, let oldest = itemCacheOrder.first {
            itemCache.removeValue(forKey: oldest); itemCacheOrder.removeFirst()
        }
        itemCache[key] = result; itemCacheOrder.append(key)
        return result
    }
}

actor MediaTransferGate {
    private var available = 2
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func acquire() async {
        if available > 0 { available -= 1; return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() {
        if waiters.isEmpty { available += 1 }
        else { waiters.removeFirst().resume() }
    }
}
