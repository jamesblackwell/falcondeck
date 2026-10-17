import Foundation

/// Only the protocol fields this client needs. Unknown fields survive
/// decoding at the JSON boundary without coupling the pilot to every extension.
enum JSON: Codable, Sendable, Hashable {
    case object([String: JSON]), array([JSON]), string(String), number(Double), bool(Bool), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([JSON].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    subscript(_ key: String) -> JSON {
        guard case .object(let v) = self else { return .null }
        return v[key] ?? .null
    }
    var string: String { if case .string(let v) = self { v } else { "" } }
    var bool: Bool { if case .bool(let v) = self { v } else { false } }
    var int: Int { if case .number(let v) = self, v.isFinite, v >= 0, v < Double(Int.max) { Int(v) } else { 0 } }
    var array: [JSON] { if case .array(let v) = self { v } else { [] } }
    func data() throws -> Data { try JSONEncoder().encode(self) }
    func wireText() throws -> String {
        // Relay transport reserves a literal type-first prefix before parsing.
        // JSONEncoder's dictionary order is intentionally unspecified.
        guard case .object(var fields) = self, let type = fields.removeValue(forKey: "type") else {
            return String(decoding: try data(), as: UTF8.self)
        }
        let first = String(decoding: try type.data(), as: UTF8.self)
        if fields.isEmpty { return "{\"type\":\(first)}" }
        let rest = String(decoding: try JSON.object(fields).data().dropFirst(), as: UTF8.self)
        return "{\"type\":\(first),\(rest)"
    }
    static func decode(_ data: Data) throws -> JSON { try JSONDecoder().decode(JSON.self, from: data) }
    func setting(_ key: String, _ value: JSON) -> JSON {
        guard case .object(var fields) = self else { return self }
        fields[key] = value
        return .object(fields)
    }
    var optionalInt: Int? {
        guard case .number(let v) = self, v.isFinite, v >= 0, v < Double(Int.max), v.rounded() == v else { return nil }
        return Int(v)
    }
}

struct PilotError: LocalizedError, Sendable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct Project: Identifiable, Hashable, Sendable {
    static func == (lhs: Project, rhs: Project) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
    let raw: JSON
    let id: String
    let path: String
    let status: String
    var name: String { URL(fileURLWithPath: path).lastPathComponent }
    init(_ value: JSON) {
        raw = value
        id = value["id"].string; path = value["path"].string; status = value["status"].string
    }
}

struct AgentTask: Identifiable, Hashable, Sendable {
    let raw: JSON
    let id: String
    let projectID: String
    let title: String
    let provider: String
    let status: String
    let preview: String
    let updatedAt: String
    let pinned: Bool
    let unread: Bool
    var pinnedInProject: Bool { raw["is_pinned_in_project"].bool }
    var modelID: String { raw["agent"]["model_id"].string }
    var effort: String { raw["agent"]["reasoning_effort"].string }
    var latestTurnID: String { raw["latest_turn_id"].string }
    var running: Bool { status == "running" }
    var awaitingInput: Bool { ["waiting_for_input", "awaiting_approval"].contains(status) || raw["attention"]["pending_approval_count"].int + raw["attention"]["pending_question_count"].int > 0 }
    var needsAttention: Bool { awaitingInput || status == "error" }
    init(_ v: JSON) {
        raw = v
        id = v["id"].string; projectID = v["workspace_id"].string
        title = v["title"].string == "Untitled thread" ? "New task" : v["title"].string; provider = v["provider"].string
        status = v["status"].string; preview = v["last_message_preview"].string
        updatedAt = v["updated_at"].string; pinned = v["is_pinned"].bool
        unread = v["attention"]["unread"].bool || v["attention"]["last_agent_activity_seq"].int > v["attention"]["last_read_seq"].int
    }
}

struct Message: Identifiable, Sendable, Equatable {
    var raw: JSON
    var id: String { raw["id"].string }
    var kind: String { raw["kind"].string }
    var text: String {
        switch kind {
        case "reasoning": raw["summary"].string.nonempty ?? raw["content"].string
        case "tool_call": raw["output"].string
        case "service": raw["message"].string
        case "diff": raw["diff"].string
        case "code_review": raw["content"].string
        default: raw["text"].string
        }
    }
    var streaming: Bool { raw["lifecycle"].string == "streaming" }
    init(_ v: JSON) { raw = v }
    var isMessage: Bool { kind == "user_message" || kind == "assistant_message" }
}

struct PairingInput: Sendable {
    let relay: URL
    let code: String
    let authoritySeed: Data

    init(text: String, relay: String) throws {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var rawCode = text
        var rawRelay = relay
        if let link = URLComponents(string: text), let scheme = link.scheme {
            guard ["https", "falcondeck", "falcondeck-native"].contains(scheme),
                  (scheme != "https" || link.path == "/pair") else { throw PilotError("Paste a pairing link or the complete secure code.") }
            rawCode = link.queryItems?.first(where: { $0.name == "code" })?.value ?? ""
            rawRelay = link.queryItems?.first(where: { $0.name == "relay" })?.value ?? relay
        }
        self.relay = try Self.relayURL(rawRelay)
        let parts = rawCode.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { throw PilotError("Use the full secure pairing link from your computer.") }
        code = parts[0].uppercased()
        var seed = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        seed += String(repeating: "=", count: (4 - seed.count % 4) % 4)
        guard let bytes = Data(base64Encoded: seed), bytes.count == 32 else { throw PilotError("The secure pairing code is incomplete.") }
        authoritySeed = bytes
    }

    static func relayURL(_ text: String) throws -> URL {
        guard var c = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = c.host, !host.isEmpty,
              c.scheme == "https" || (c.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(host)),
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil else {
            throw PilotError("Use an HTTPS relay address. HTTP is supported only on localhost.")
        }
        while c.path.hasSuffix("/") { c.path.removeLast() }
        guard let url = c.url else { throw PilotError("The relay address is invalid.") }
        return url
    }
}
