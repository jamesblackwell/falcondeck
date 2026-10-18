import SwiftUI

struct ComposerOptions: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    let project: Project?
    @Bindable var chat: ChatSession
    @State private var showSettings = false
    private var currentProject: Project? { model.projects.first { $0.id == task.projectID } ?? project }
    private var capabilities: JSON { currentProject?.capabilities(task.provider) ?? .null }
    private var modes: [JSON] { currentProject?.modes(task.provider) ?? [] }
    private var activeModel: AgentModel? { currentProject?.resolvedModel(for: task.provider, id: chat.modelID) }
    var body: some View {
        Button { showSettings = true } label: {
            Image(systemName: "slider.horizontal.3").font(.system(size: ComposerMetrics.iconSize))
                .frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize).contentShape(.rect)
        }.buttonStyle(.plain).accessibilityLabel("Agent and task settings")
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                Form { settings }
                    .scrollContentBackground(.hidden).background(FD.background)
                    .navigationTitle("Task settings").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showSettings = false } } }
            }.nativeOptionsSheet()
        }
        .onChange(of: chat.provider) { _, provider in
            guard task.isDraft else { return }
            chat.modelID = ""; chat.effort = ""; chat.overrides = [:]
        }
    }
    @ViewBuilder private var settings: some View {
        Section {
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
        }.listRowBackground(FD.surface)
    }
    private func modePicker(_ label: String, key: String, options: [(String, String)]) -> some View {
        Picker(label, selection: Binding(get: { (chat.overrides[key] ?? task.raw["agent"][key]).string.nonempty ?? (key == "service_tier" ? "default" : "") }, set: { value in
            chat.overrides[key] = value.isEmpty ? .null : .string(value)
            if key == "permission_mode", task.provider == "codex" { chat.overrides["approval_policy"] = value.isEmpty ? .null : .string(value == "default" ? "on-request" : value) }
        })) {
            if key == "service_tier" { Text("Standard").tag("default") }
            else { Text("Default").tag("") }
            ForEach(options, id: \.0) { option in Text(option.1.nonempty ?? modeLabel(option.0)).tag(option.0) }
        }
    }
    private func modeLabel(_ value: String) -> String {
        let labels = ["default": "Ask to approve", "acceptEdits": "Accept edits", "auto": "Auto", "dontAsk": "Don't ask", "bypassPermissions": "Bypass permissions", "always-approve": "Always approve", "untrusted": "Untrusted only", "on-failure": "Ask on failure", "on-request": "Ask when needed", "never": "Never ask", "read-only": "Read only", "workspace-write": "Workspace write", "danger-full-access": "Full access"]
        return labels[value] ?? value.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ").capitalized
    }
}
