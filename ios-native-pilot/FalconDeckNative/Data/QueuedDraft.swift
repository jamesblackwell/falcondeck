import Foundation

struct QueuedDraft: Sendable {
    let id: String
    let text: String
    let attachmentCount: Int
    var knownIDs: Set<String>
    var json: JSON { .object(["id": .string(id), "text": .string(text), "preview": .string(String(text.prefix(140))), "attachment_count": .number(Double(attachmentCount)), "pending": .bool(true)]) }

    static func reconcile(_ pending: [QueuedDraft], queued: [JSON], items: [Message]) -> [QueuedDraft] {
        guard !pending.isEmpty else { return [] }
        var claimed: Set<String> = []
        var remaining: [QueuedDraft] = []
        for entry in pending {
            if items.contains(where: { $0.id == entry.id && !$0.raw["pending"].bool }) { continue }
            if let match = queued.first(where: {
                !entry.knownIDs.contains($0["id"].string) && !claimed.contains($0["id"].string) &&
                ($0["text"] == .null ? $0["preview"].string == String(entry.text.prefix(140)) : $0["text"].string.trimmingCharacters(in: .whitespacesAndNewlines) == entry.text) &&
                ($0["attachment_count"] == .null || $0["attachment_count"].int == entry.attachmentCount)
            }) { claimed.insert(match["id"].string) }
            else { remaining.append(entry) }
        }
        if !claimed.isEmpty { for index in remaining.indices { remaining[index].knownIDs.formUnion(claimed) } }
        return remaining
    }
}
