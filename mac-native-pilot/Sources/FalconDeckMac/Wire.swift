import Foundation

/// A deliberately small, forward-compatible view of the daemon protocol.
/// Unknown fields stay available to presentation without duplicating the schema.
enum JSON: Codable, Sendable, Hashable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode([JSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    subscript(_ key: String) -> JSON {
        guard case .object(let value) = self else { return .null }
        return value[key] ?? .null
    }

    var string: String { if case .string(let value) = self { value } else { "" } }
    var bool: Bool { if case .bool(let value) = self { value } else { false } }
    var array: [JSON] { if case .array(let value) = self { value } else { [] } }
    var fields: [String: JSON] { if case .object(let value) = self { value } else { [:] } }
    var double: Double { if case .number(let value) = self { value } else { 0 } }
    var optionalInt: Int? {
        guard case .number(let value) = self, value.isFinite, value >= 0,
              value < Double(Int.max), value.rounded() == value else { return nil }
        return Int(value)
    }
    var int: Int { optionalInt ?? 0 }

    func data() throws -> Data { try JSONEncoder().encode(self) }
    static func decode(_ data: Data) throws -> JSON { try JSONDecoder().decode(JSON.self, from: data) }
    func setting(_ key: String, _ value: JSON) -> JSON {
        guard case .object(var fields) = self else { return self }
        fields[key] = value
        return .object(fields)
    }
}

extension String {
    var nonempty: String? { isEmpty ? nil : self }
}

struct PilotError: LocalizedError, Sendable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct Project: Identifiable, Hashable, Sendable {
    let raw: JSON
    var id: String { raw["id"].string }
    var path: String { raw["path"].string }
    var status: String { raw["status"].string }
    var name: String {
        if raw["kind"].string == "casual" { return "Chat" }
        return URL(fileURLWithPath: path).lastPathComponent
    }
    var defaultProvider: String {
        let value = raw["default_provider"].string
        return value.isEmpty ? "codex" : value
    }
    var providers: [String] {
        let values = raw["agents"].array.map { $0["provider"].string }.filter { !$0.isEmpty }
        return values.isEmpty ? [defaultProvider] : values
    }
    init(_ value: JSON) { raw = value }
    static func == (lhs: Project, rhs: Project) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

struct AgentTask: Identifiable, Hashable, Sendable {
    let raw: JSON
    var id: String { raw["id"].string }
    var projectID: String { raw["workspace_id"].string }
    var title: String {
        let title = raw["title"].string
        return title.isEmpty || title == "Untitled thread" ? "New conversation" : title
    }
    var provider: String { raw["provider"].string }
    var status: String { raw["status"].string }
    var preview: String { raw["last_message_preview"].string }
    /// What lists should show: one line, no markdown punctuation, no scheduler
    /// envelope. `preview` stays raw so search still matches the stored text.
    var previewLine: String { NativePlainText.line(preview) }
    var updatedAt: String { raw["updated_at"].string }
    var pinned: Bool { raw["is_pinned"].bool }
    var unread: Bool {
        raw["attention"]["unread"].bool || raw["attention"]["last_agent_activity_seq"].int > raw["attention"]["last_read_seq"].int
    }
    var running: Bool { status == "running" || (status == "idle" && raw["attention"]["background_task_count"].int > 0) }
    var awaitingInput: Bool {
        ["waiting_for_input", "awaiting_approval"].contains(status)
        || raw["attention"]["pending_approval_count"].int + raw["attention"]["pending_question_count"].int > 0
    }
    var needsAttention: Bool { awaitingInput || status == "error" }
    var modelID: String { raw["agent"]["model_id"].string }
    var latestTurnID: String { raw["latest_turn_id"].string }
    init(_ value: JSON) { raw = value }
}

struct Message: Identifiable, Sendable, Equatable {
    var raw: JSON
    var id: String { raw["id"].string }
    var kind: String { raw["kind"].string }
    var role: String {
        switch kind {
        case "user_message": "user"
        case "assistant_message", "reasoning": "assistant"
        default: "system"
        }
    }
    var text: String {
        switch kind {
        case "reasoning": raw["summary"].string.isEmpty ? raw["content"].string : raw["summary"].string
        case "tool_call": raw["output"].string
        case "service": raw["message"].string
        case "diff": raw["diff"].string
        case "code_review": raw["content"].string
        case "unsupported": raw["reason"].string
        default: raw["text"].string
        }
    }
    var title: String { raw["title"].string }
    var status: String { raw["status"].string }
    var streaming: Bool { raw["lifecycle"].string == "streaming" }
    var running: Bool { status == "running" || kind == "tool_call" && status == "in_progress" }
    var isMessage: Bool { kind == "user_message" || kind == "assistant_message" }
    init(_ value: JSON) { raw = value }
}
