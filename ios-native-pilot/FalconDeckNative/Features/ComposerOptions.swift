import SwiftUI

struct ComposerOptions: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    let project: Project?
    @Bindable var chat: ChatSession
    private var capabilities: JSON { project?.capabilities(task.provider) ?? .null }
    private var modes: [JSON] { project?.modes(task.provider) ?? [] }
    private var activeModel: AgentModel? { project?.models(for: task.provider).first { $0.id == chat.modelID } ?? project?.models(for: task.provider).first { $0.raw["is_default"].bool } }
    var body: some View {
        Menu {
            if task.isDraft {
                Picker("Agent", selection: $chat.provider) {
                    ForEach(project?.providers ?? [task.provider], id: \.self) { Text($0.capitalized).tag($0) }
                }
            }
            if !modes.isEmpty {
                modePicker("Mode", key: "collaboration_mode_id", options: modes.map { ($0["id"].string, $0["label"].string) })
            }
            if !capabilities["permission_modes"].array.isEmpty {
                modePicker("Permissions", key: "permission_mode", options: capabilities["permission_modes"].array.map { ($0.string, modeLabel($0.string)) })
            }
            if !capabilities["sandbox_modes"].array.isEmpty {
                modePicker("Sandbox", key: "sandbox_mode", options: capabilities["sandbox_modes"].array.map { ($0.string, modeLabel($0.string)) })
            }
            if let activeModel, !activeModel.raw["service_tiers"].array.isEmpty {
                modePicker("Speed", key: "service_tier", options: activeModel.raw["service_tiers"].array.map { ($0["id"].string, $0["name"].string) })
            }
        } label: { Image(systemName: "slider.horizontal.3").padding(.vertical, 4) }
            .accessibilityLabel("Agent and task settings")
            .onChange(of: chat.provider) { _, provider in
                guard task.isDraft else { return }
                chat.modelID = ""; chat.effort = ""; chat.overrides = [:]
                if let project, project.models(for: provider).isEmpty, !model.demo {
                    Task {
                        do { _ = try await model.relay.call("provider.hydrate", params: .object(["workspace_id": .string(project.id), "provider": .string(provider)])) }
                        catch { chat.error = error.localizedDescription }
                    }
                }
            }
    }
    private func modePicker(_ label: String, key: String, options: [(String, String)]) -> some View {
        Picker(label, selection: Binding(get: { (chat.overrides[key] ?? task.raw["agent"][key]).string.nonempty ?? (key == "service_tier" ? "standard" : "") }, set: { value in
            chat.overrides[key] = value.isEmpty ? .null : .string(value)
            if key == "permission_mode", task.provider == "codex" { chat.overrides["approval_policy"] = value.isEmpty ? .null : .string(value == "default" ? "on-request" : value) }
        })) {
            if key == "service_tier" { Text("Standard").tag("standard") }
            else { Text("Default").tag("") }
            ForEach(options, id: \.0) { option in Text(option.1.nonempty ?? modeLabel(option.0)).tag(option.0) }
        }
    }
    private func modeLabel(_ value: String) -> String {
        let labels = ["default": "Ask to approve", "acceptEdits": "Accept edits", "auto": "Auto", "dontAsk": "Don't ask", "bypassPermissions": "Bypass permissions", "always-approve": "Always approve", "untrusted": "Untrusted only", "on-failure": "Ask on failure", "on-request": "Ask when needed", "never": "Never ask", "read-only": "Read only", "workspace-write": "Workspace write", "danger-full-access": "Full access"]
        return labels[value] ?? value.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ").capitalized
    }
}
