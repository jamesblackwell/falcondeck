import Foundation
import CryptoKit

struct NativeComposerSelection: Codable, Equatable {
    var fields: [String: JSON] = [:]
    var isolation = "project_folder"
    var followUp = "queue"

    func value(_ key: String, task: AgentTask?) -> String {
        (fields[key] ?? task?.raw["agent"][key] ?? .null).string
    }

    mutating func select(_ key: String, value: String, provider: String) {
        fields[key] = value.isEmpty ? .null : .string(value)
        if key == "model_id" {
            fields["reasoning_effort"] = .null
            fields.removeValue(forKey: "service_tier")
        }
        if key == "permission_mode", provider == "codex" {
            fields["approval_policy"] = value.isEmpty ? .null : .string(value == "default" ? "on-request" : value)
        }
    }

    func validated(project: Project?, provider: String) -> Self {
        var result = self
        let capability = ConversationCatalog.agent(project, provider: provider)["capabilities"]
        for key in ["permission_mode", "sandbox_mode"] {
            if let mode = result.fields[key], mode != .null,
               !capability[key + "s"].array.contains(mode) {
                result.fields.removeValue(forKey: key)
                if key == "permission_mode" { result.fields.removeValue(forKey: "approval_policy") }
            }
        }
        let models = ConversationCatalog.models(project, provider: provider)
        if let modelID = result.fields["model_id"], modelID != .null, !models.isEmpty,
           !models.contains(where: { $0["id"] == modelID }) {
            result.fields.removeValue(forKey: "model_id")
            result.fields.removeValue(forKey: "reasoning_effort")
            result.fields.removeValue(forKey: "service_tier")
        }
        let effectiveID = result.fields["model_id"]?.string ?? ""
        if let model = models.first(where: { $0["id"].string == effectiveID }) ?? models.first(where: { $0["is_default"].bool }) {
            if let effort = result.fields["reasoning_effort"], effort != .null,
               !ConversationCatalog.efforts(model).contains(effort.string) {
                result.fields.removeValue(forKey: "reasoning_effort")
            }
            if let tier = result.fields["service_tier"], tier != .null, tier != .string("default"),
               !model["service_tiers"].array.contains(where: { $0["id"] == tier }) {
                result.fields.removeValue(forKey: "service_tier")
            }
        }
        let modes = ConversationCatalog.agent(project, provider: provider)["collaboration_modes"].array
        if let mode = result.fields["collaboration_mode_id"], mode != .null, !modes.isEmpty,
           !modes.contains(where: { $0["id"] == mode }) {
            result.fields.removeValue(forKey: "collaboration_mode_id")
        }
        return result
    }
}

enum ConversationCatalog {
    static func agent(_ project: Project?, provider: String) -> JSON {
        project?.raw["agents"].array.first { $0["provider"].string == provider }
            ?? (provider == project?.defaultProvider ? project?.raw ?? .null : .null)
    }
    static func models(_ project: Project?, provider: String) -> [JSON] {
        let offered = agent(project, provider: provider)["models"]
        return offered == .null && provider == project?.defaultProvider ? project?.raw["models"].array ?? [] : offered.array
    }
    static func efforts(_ model: JSON) -> [String] {
        model["supported_reasoning_efforts"].array.compactMap {
            let id = $0["reasoning_effort"].string.isEmpty ? $0["id"].string : $0["reasoning_effort"].string
            return id.isEmpty ? nil : id
        }
    }
    static func alias(_ text: String) -> String {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"^[/$]+"#, with: "", options: .regularExpression)
            .lowercased().replacingOccurrences(of: #"[\s_]+"#, with: "-", options: .regularExpression)
            .replacingOccurrences(of: #"[^a-z0-9-]"#, with: "", options: .regularExpression)
        return "/" + value
    }
    static func selectedSkills(_ text: String, skills: [JSON]) -> [JSON] {
        guard let expression = try? NSRegularExpression(pattern: #"(?:^|\s)(/[A-Za-z0-9_-]+)(?![A-Za-z0-9_/-])"#) else { return [] }
        var seen: Set<String> = []
        return expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            guard let range = Range(match.range(at: 1), in: text),
                  let skill = skills.last(where: { alias($0["alias"].string) == alias(String(text[range])) }),
                  seen.insert(skill["id"].string).inserted else { return nil }
            return .object(["skill_id": skill["id"], "alias": skill["alias"]])
        }
    }
    static func label(_ text: String) -> String {
        ["default": "Ask to approve", "acceptEdits": "Accept edits", "auto": "Auto", "dontAsk": "Don't ask",
         "bypassPermissions": "Bypass permissions", "always-approve": "Always approve", "untrusted": "Untrusted only",
         "on-failure": "Ask on failure", "on-request": "Ask when needed", "never": "Never ask", "read-only": "Read only",
         "workspace-write": "Workspace write", "danger-full-access": "Full access", "project_folder": "Project folder", "isolated": "Isolated checkout"][text]
        ?? text.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ").capitalized
    }
}

enum ConversationLocalStorage {
    static func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let url = url(key), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
    static func save<T: Encodable>(_ value: T, key: String) {
        guard let url = url(key), let data = try? JSONEncoder().encode(value) else { return }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch { NSLog("Could not save native composer state: %@", error.localizedDescription) }
    }
    private static func url(_ key: String) -> URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("FalconDeck Native/Composer", isDirectory: true)
            .appendingPathComponent(SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined() + ".json")
    }
}
