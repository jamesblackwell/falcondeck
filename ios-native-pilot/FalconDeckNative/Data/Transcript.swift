import Foundation

/// A selected task's in-memory transcript. Offsets on the wire are UTF-16,
/// matching JavaScript and the daemon, rather than Swift Character counts.
struct Transcript: Sendable {
    var items: [Message] = []
    var needsRecovery = false
    var revision = 0

    mutating func upsert(_ item: Message) {
        guard !item.id.isEmpty else { return }
        if let index = items.firstIndex(where: { $0.id == item.id }) { items[index] = item }
        else { items.append(item) }
        revision += 1
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
            let index = items.firstIndex { $0.id == id }
            var raw = index.map { items[$0].raw } ?? .object(["id": .string(id), "kind": .string(kind)])
            let current = raw[field].string, delta = event["delta"].string
            // optionalInt rejects negative/fractional values before slicing.
            if let start = event["start_offset"].optionalInt, let end = event["end_offset"].optionalInt {
                guard end >= start, delta.utf16.count == end - start else { needsRecovery = true; return }
                let currentUnits = Array(current.utf16), deltaUnits = Array(delta.utf16)
                guard start <= currentUnits.count else {
                    // Detail pages deliberately cap tool previews; their byte
                    // count cannot be used as a UTF-16 streaming cursor.
                    if kind != "tool_call" || raw["display"]["output_total_bytes"] == .null { needsRecovery = true }
                    return
                }
                let overlap = min(currentUnits.count - start, deltaUnits.count)
                guard currentUnits[start..<(start + overlap)].elementsEqual(deltaUnits.prefix(overlap)) else { needsRecovery = true; return }
                if end <= currentUnits.count { return }
                let suffix = deltaUnits.dropFirst(overlap)
                raw = raw.setting(field, .string(current + String(decoding: suffix, as: UTF16.self)))
            } else {
                guard event["start_offset"] == .null, event["end_offset"] == .null else { needsRecovery = true; return }
                raw = raw.setting(field, .string(current + delta))
            }
            if !["complete", "interrupted", "error"].contains(raw["lifecycle"].string) {
                raw = raw.setting("lifecycle", .string("streaming"))
            }
            upsert(Message(raw))
        case "tool-call-start":
            // A start can be replayed over a newer authoritative detail page.
            guard !items.contains(where: { $0.id == event["item_id"].string }) else { return }
            upsert(Message(.object(["id": event["item_id"], "kind": .string("tool_call"), "title": event["title"], "tool_kind": event["kind"], "status": .string("running")])))
        case "tool-call-end":
            let raw = items.first { $0.id == event["item_id"].string }?.raw ?? .object(["id": event["item_id"], "kind": .string("tool_call"), "title": event["title"]])
            upsert(Message(raw.setting("status", event["status"]).setting("exit_code", event["exit_code"])))
        case "turn-end":
            for index in items.indices where items[index].streaming {
                items[index].raw = items[index].raw.setting("lifecycle", .string("complete"))
            }
            revision += 1
        default: break
        }
    }

    mutating func prepend(_ older: [Message]) {
        var existing = Set(items.map(\.id))
        items.insert(contentsOf: older.filter { !$0.id.isEmpty && existing.insert($0.id).inserted }, at: 0)
        revision += 1
    }
}

enum NativeRequest {
    static func turnSettings(_ overrides: [String: JSON], task: AgentTask, model: AgentModel?) -> [String: JSON] {
        var result = overrides
        let tiers = model?.raw["service_tiers"].array ?? []
        if tiers.isEmpty { result.removeValue(forKey: "service_tier") }
        else {
            let selected = (overrides["service_tier"] ?? task.raw["agent"]["service_tier"]).string
            result["service_tier"] = .string(tiers.contains(where: { $0["id"].string == selected }) ? selected : "default")
        }
        return result
    }
    static func turn(task: AgentTask, text: String, itemID: String, modelID: String, effort: String, overrides: [String: JSON] = [:], attachments: [NativeAttachment] = []) -> JSON {
        var result = JSON.object([
            "workspace_id": .string(task.projectID), "thread_id": .string(task.id), "provider": .string(task.provider),
            "inputs": .array((text.isEmpty ? [] : [.object(["type": .string("text"), "text": .string(text)])]) + attachments.map(\.input)),
            "user_item_id": .string(itemID)
        ])
        // Omitted permissions preserve the task's existing settings. Changing
        // the model or effort never silently broadens access to the computer.
        if !modelID.isEmpty { result = result.setting("model_id", .string(modelID)) }
        if !effort.isEmpty { result = result.setting("reasoning_effort", .string(effort)) }
        for key in ["permission_mode", "sandbox_mode", "service_tier", "approval_policy"] {
            if let value = overrides[key] { result = result.setting(key, value) }
        }
        return result
    }
    static func events(_ payload: JSON) -> [JSON] {
        switch payload["kind"].string {
        case "daemon-event": [payload["event"]]
        case "daemon-events": payload["events"].array
        default: []
        }
    }
}

struct ProjectFolder: Identifiable, Hashable, Sendable {
    let raw: JSON
    var id: String { raw["id"].string }
    var projectID: String { raw["workspace_id"].string }
    var name: String { raw["name"].string }
    var collapsed: Bool { raw["collapsed"].bool }
    var taskIDs: Set<String> { Set(raw["thread_ids"].array.map(\.string)) }
}

struct AgentModel: Identifiable, Hashable, Sendable {
    let raw: JSON
    var id: String { raw["id"].string }
    var label: String { raw["label"].string.nonempty ?? id }
    var efforts: [String] { raw["supported_reasoning_efforts"].array.map { $0["reasoning_effort"].string.nonempty ?? $0["id"].string }.filter { !$0.isEmpty } }
}

extension Project {
    var defaultProvider: String { raw["default_provider"].string.nonempty ?? "codex" }
    var providers: [String] {
        let values = raw["agents"].array.map { $0["provider"].string }.filter { !$0.isEmpty }
        return values.isEmpty ? [defaultProvider] : values
    }
    func models(for provider: String) -> [AgentModel] {
        let agent = raw["agents"].array.first { $0["provider"].string == provider }
        let values = agent?["models"].array ?? (provider == defaultProvider ? raw["models"].array : [])
        return values.map { AgentModel(raw: $0) }
    }
}
