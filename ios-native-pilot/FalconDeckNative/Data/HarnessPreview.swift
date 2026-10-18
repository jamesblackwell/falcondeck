#if DEBUG
import Foundation

/// Local contract fixtures for composer QA. No CLI, credentials, or agent turn
/// is started: these mirror normalized daemon metadata for each transport.
enum HarnessPreview {
    static func model(_ id: String, label: String, efforts: [String], defaultModel: Bool = true) -> JSON {
        .object(["id": .string(id), "label": .string(label), "is_default": .bool(defaultModel),
                 "default_reasoning_effort": efforts.first.map(JSON.string) ?? .null,
                 "supported_reasoning_efforts": .array(efforts.map { .object(["reasoning_effort": .string($0)]) })])
    }
    static var task: AgentTask {
        let argument = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--loading-preview=harness-") } ?? ""
        let provider = String(argument.dropFirst("--loading-preview=harness-".count))
        let selected = selections.first { $0.0 == provider } ?? selections[0]
        return AgentTask(LoadingPreviewRelay.task.raw.setting("provider", .string(selected.0)).setting("agent", .object(["model_id": .string(selected.1), "reasoning_effort": .string(selected.2)])))
    }
    static let selections = [("codex", "gpt-5.4", "high"), ("claude", "fable", "max"), ("opencode", "openrouter/z-ai/glm-5", "high")]
    static let project: Project = {
        let catalogs: [(String, [JSON], [String])] = [
            ("codex", [model("gpt-5.4", label: "GPT-5.4", efforts: ["low", "medium", "high", "xhigh"])], ["on-request", "never"]),
            ("claude", [model("fable", label: "Fable 5.1", efforts: ["low", "medium", "high", "max"])], ["default", "acceptEdits"]),
            ("opencode", [model("default", label: "OpenCode default", efforts: []),
                          model("openrouter/z-ai/glm-5", label: "GLM 5 · openrouter", efforts: ["default", "low", "high", "max"], defaultModel: false),
                          model("google/gemini-plain", label: "Gemini plain · google", efforts: [], defaultModel: false)]
                + (0..<15).map { model("local/model-\($0)", label: "Local model \($0)", efforts: [], defaultModel: false) }, ["default", "always-approve"])
        ]
        let agents = catalogs.map { provider, models, permissions in
            JSON.object(["provider": .string(provider), "models": .array(models), "capabilities": .object([
                "supports_images": .bool(provider != "opencode"), "permission_modes": .array(permissions.map(JSON.string)),
                "sandbox_modes": .array(provider == "codex" ? [.string("workspace-write"), .string("read-only")] : [])
            ]), "collaboration_modes": .array([.object(["id": .string(provider == "opencode" ? "build" : "default"), "label": .string("Default")])])])
        }
        return Project(Demo.projects[0].raw.setting("default_provider", .string("codex")).setting("agents", .array(agents)))
    }()
}
#endif
