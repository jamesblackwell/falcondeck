import Foundation
import Observation

@MainActor @Observable final class ComposerCatalog {
    var skills: [JSON] = []
    var prompts: [JSON] = []
    var loading = false
    var error: String?
    var loaded = false
    @ObservationIgnored var request: Task<Void, Never>?
    static func alias(_ input: String) -> String {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: #"^[/$]+"#, with: "", options: .regularExpression).lowercased()
            .replacingOccurrences(of: #"[\s_]+"#, with: "-", options: .regularExpression).replacingOccurrences(of: "-+", with: "-", options: .regularExpression).replacingOccurrences(of: "[^a-z0-9-]", with: "", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return "/" + (text.nonempty ?? "skill")
    }
    static func selected(_ text: String, skills: [JSON]) -> [JSON] {
        guard let regex = try? NSRegularExpression(pattern: #"(?:^|\s)(/[A-Za-z0-9_-]+)(?![A-Za-z0-9_/-])"#) else { return [] }
        var seen: Set<String> = []
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            guard let range = Range(match.range(at: 1), in: text), let skill = skills.last(where: { alias($0["alias"].string) == alias(String(text[range])) }), seen.insert(skill["id"].string).inserted else { return nil }
            return .object(["skill_id": skill["id"], "alias": skill["alias"]])
        }
    }
    static func supports(_ skill: JSON, provider: String) -> Bool {
        let providers = skill["providers"].array.map(\.string)
        return providers.isEmpty ? ["both", provider].contains(skill["availability"].string) : providers.contains(provider)
    }
}

@MainActor extension AppModel {
    func catalog(_ task: AgentTask) -> ComposerCatalog {
        let key = task.projectID + ":" + task.provider
        if let existing = composerCatalogs[key] { return existing }
        let value = ComposerCatalog(); composerCatalogs[key] = value
        return value
    }
    func loadCatalog(_ task: AgentTask, force: Bool = false) async {
        let value = catalog(task)
        if let request = value.request { await request.value; return }
        guard force || !value.loaded, demo || connected else { return }
        value.loading = true; value.error = nil
        let current = connectionID
        if demo { value.loaded = true; value.loading = false; return }
        let request = Task {
            defer { value.loading = false }
            do {
                async let skills = relay.call("workspace.skills", params: .object(["workspace_id": .string(task.projectID), "provider": .string(task.provider)]))
                async let prompts = relay.call("workspace.prompts", params: .object(["workspace_id": .string(task.projectID)]))
                let results = try await (skills, prompts)
                guard current == connectionID else { return }
                value.skills = results.0["skills"].array.filter { ComposerCatalog.supports($0, provider: task.provider) }
                value.prompts = results.1["prompts"].array; value.loaded = true
            } catch { if current == connectionID { value.error = error.localizedDescription } }
        }
        value.request = request
        await request.value
        value.request = nil
    }
}
