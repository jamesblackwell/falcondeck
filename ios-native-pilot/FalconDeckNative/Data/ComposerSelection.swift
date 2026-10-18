import Foundation

struct ComposerSelection: Codable, Sendable, Equatable {
    var modelID: String
    var effort: String
    var overrides: [String: JSON]

    /// Remember display choices, but only restore access modes still advertised
    /// by this provider. A cached model list never grants a capability.
    func validated(project: Project?, provider: String) -> Self {
        var result = self
        let capabilities = project?.capabilities(provider) ?? .null
        for key in ["permission_mode", "sandbox_mode"] {
            if let value = result.overrides[key], !capabilities[key + "s"].array.contains(value) {
                result.overrides.removeValue(forKey: key)
            }
        }
        if result.overrides["permission_mode"] == nil { result.overrides.removeValue(forKey: "approval_policy") }
        let modes = project?.modes(provider) ?? []
        if let mode = result.overrides["collaboration_mode_id"], !modes.contains(where: { $0["id"] == mode }) {
            result.overrides.removeValue(forKey: "collaboration_mode_id")
        }
        // Empty live catalogs are lazy metadata, not proof a chosen model was
        // removed. Validate against a nonempty live catalog when available.
        let models = project?.models(for: provider) ?? []
        if !models.isEmpty, !result.modelID.isEmpty, !models.contains(where: { $0.id == result.modelID }) {
            result.modelID = ""; result.effort = ""
            result.overrides.removeValue(forKey: "model_id")
            result.overrides.removeValue(forKey: "reasoning_effort")
            result.overrides.removeValue(forKey: "service_tier")
        } else if let model = AgentModel.resolve(models: models, provider: provider, id: result.modelID), !models.isEmpty {
            if !result.effort.isEmpty, !model.efforts.contains(result.effort) {
                result.effort = ""; result.overrides.removeValue(forKey: "reasoning_effort")
            }
            if let tier = result.overrides["service_tier"], tier != .string("default"), !model.raw["service_tiers"].array.contains(where: { $0["id"] == tier }) {
                result.overrides.removeValue(forKey: "service_tier")
            }
        }
        return result
    }
}

struct WorkspaceComposerPreferences: Codable, Sendable, Equatable {
    var provider: String
    var selections: [String: ComposerSelection] = [:]
}

@MainActor extension ChatSession {
    var composerSelection: ComposerSelection { ComposerSelection(modelID: modelID, effort: effort, overrides: overrides) }
    func applySelection(_ selection: ComposerSelection) {
        restoringSelection = true
        modelID = selection.modelID; effort = selection.effort; overrides = selection.overrides
        restoringSelection = false
        changed?()
    }
    func reconcileSettings(_ task: AgentTask) {
        guard !task.isDraft else { return }
        restoringSelection = true
        defer { restoringSelection = false }
        for (key, value) in overrides where value == task.raw["agent"][key] {
            overrides.removeValue(forKey: key)
        }
        if overrides["model_id"] == nil, modelID != task.modelID { modelID = task.modelID }
        if overrides["reasoning_effort"] == nil, effort != task.effort { effort = task.effort }
    }
    func chooseModel(_ id: String) {
        guard id != modelID else { return }
        var settings = overrides
        settings["model_id"] = id.isEmpty ? .null : .string(id)
        settings["reasoning_effort"] = .null
        settings.removeValue(forKey: "service_tier")
        applySelection(ComposerSelection(modelID: id, effort: "", overrides: settings))
    }
    func chooseEffort(_ value: String) {
        effort = value; overrides["reasoning_effort"] = value.isEmpty ? .null : .string(value)
    }
}

@MainActor extension AppModel {
    func rememberComposer(projectID: String, chat: ChatSession) {
        var workspace = composerPreferences[projectID] ?? WorkspaceComposerPreferences(provider: chat.provider)
        workspace.provider = chat.provider
        workspace.selections[chat.provider] = chat.composerSelection
        if composerPreferences[projectID] != workspace { composerPreferences[projectID] = workspace }
    }
    func chooseProvider(_ provider: String, task: AgentTask, chat: ChatSession) {
        guard task.isDraft, provider != chat.provider,
              let project = projects.first(where: { $0.id == task.projectID }), project.providers.contains(provider) else { return }
        rememberComposer(projectID: task.projectID, chat: chat)
        let selection = composerPreferences[task.projectID]?.selections[provider]
            ?? ComposerSelection(modelID: "", effort: "", overrides: [:])
        chat.restoringSelection = true; chat.provider = provider; chat.restoringSelection = false
        chat.applySelection(selection.validated(project: project, provider: provider))
    }
}
