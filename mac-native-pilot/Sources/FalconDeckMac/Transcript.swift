import Foundation

/// A selected task's in-memory transcript. Offsets on the wire are UTF-16,
/// matching JavaScript and the daemon, rather than Swift Character counts.
struct Transcript: Sendable {
    var items: [Message] {
        didSet {
            revision &+= 1
            if !internalMutation { positions = nil; utf16Lengths = [:] }
        }
    }
    var needsRecovery = false
    private(set) var revision: Int
    private var positions: [String: Int]?
    private var utf16Lengths: [String: [String: Int]] = [:]
    private var internalMutation = false

    init(items: [Message] = [], revision: Int = 0) { self.items = items; self.revision = revision }

    private mutating func position(_ id: String) -> Int? {
        if positions == nil { positions = Dictionary(items.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first }) }
        return positions?[id]
    }

    mutating func upsert(_ item: Message) {
        guard !item.id.isEmpty else { return }
        let index = position(item.id)
        utf16Lengths.removeValue(forKey: item.id)
        internalMutation = true; defer { internalMutation = false }
        if let index { items[index] = item }
        else { positions?[item.id] = items.count; items.append(item) }
    }

    mutating func apply(_ event: JSON) {
        switch event["type"].string {
        case "realtime-item-added":
            upsert(Message(event["item"].setting("kind", .string("realtime"))))
        case "conversation-item-added", "conversation-item-updated": upsert(Message(event["item"]))
        case "text":
            let id = event["item_id"].string, target = event["target"].string
            let field: String
            let kind: String
            switch target {
            case "reasoning_summary": field = "summary"; kind = "reasoning"
            case "reasoning_content": field = "content"; kind = "reasoning"
            case "tool_output": field = "output"; kind = "tool_call"
            case "plan_explanation": return // Full plan items carry the authoritative structure.
            default: field = "text"; kind = "assistant_message"
            }
            let index = position(id)
            var raw = index.map { items[$0].raw } ?? .object(["id": .string(id), "kind": .string(kind)])
            let current = raw[field].string, delta = event["delta"].string
            // optionalInt rejects negative/fractional values before slicing.
            if let start = event["start_offset"].optionalInt, let end = event["end_offset"].optionalInt {
                guard end >= start, delta.utf16.count == end - start else { needsRecovery = true; return }
                let length = utf16Lengths[id]?[field] ?? current.utf16.count
                guard start <= length else {
                    if kind != "tool_call" || raw["display"]["output_total_bytes"] == .null { needsRecovery = true }
                    return
                }
                if start == length {
                    // Normal ordered delivery needs no copy of the whole UTF-16
                    // prefix. Only replay/overlap needs the slower validation.
                    raw = raw.setting(field, .string(current + delta))
                } else {
                    let currentUnits = Array(current.utf16), deltaUnits = Array(delta.utf16)
                    let overlap = min(length - start, deltaUnits.count)
                    guard currentUnits[start..<(start + overlap)].elementsEqual(deltaUnits.prefix(overlap)) else { needsRecovery = true; return }
                    if end <= length { return }
                    raw = raw.setting(field, .string(current + String(decoding: deltaUnits.dropFirst(overlap), as: UTF16.self)))
                }
            } else {
                guard event["start_offset"] == .null, event["end_offset"] == .null else { needsRecovery = true; return }
                raw = raw.setting(field, .string(current + delta))
            }
            if !["complete", "interrupted", "error"].contains(raw["lifecycle"].string) {
                raw = raw.setting("lifecycle", .string("streaming"))
            }
            upsert(Message(raw))
            if let end = event["end_offset"].optionalInt { utf16Lengths[id, default: [:]][field] = end }
        case "tool-call-start":
            // A start can be replayed over a newer authoritative detail page.
            guard position(event["item_id"].string) == nil else { return }
            upsert(Message(.object(["id": event["item_id"], "kind": .string("tool_call"), "title": event["title"], "tool_kind": event["kind"], "status": .string("running")])))
        case "tool-call-end":
            let raw = position(event["item_id"].string).map { items[$0].raw } ?? .object(["id": event["item_id"], "kind": .string("tool_call"), "title": event["title"]])
            upsert(Message(raw.setting("status", event["status"]).setting("exit_code", event["exit_code"])))
        case "turn-end":
            internalMutation = true; defer { internalMutation = false }
            for index in items.indices where items[index].streaming {
                items[index].raw = items[index].raw.setting("lifecycle", .string("complete"))
            }
            revision &+= 1
        default: break
        }
    }

    mutating func prepend(_ older: [Message]) {
        var existing = Set(items.map(\.id))
        items.insert(contentsOf: older.filter { !$0.id.isEmpty && existing.insert($0.id).inserted }, at: 0)
    }
}
