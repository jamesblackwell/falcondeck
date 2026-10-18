import SwiftUI

struct ComposerModelSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.nativeMotion) private var motion
    let task: AgentTask
    @Bindable var chat: ChatSession
    let models: [AgentModel]
    let done: () -> Void
    @State private var query = ""
    @State private var feedback = 0
    private var activeModel: AgentModel? { AgentModel.resolve(models: models, provider: task.provider, id: chat.modelID) }
    private var filtered: [AgentModel] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? models : models.filter { $0.label.localizedStandardContains(text) || $0.id.localizedStandardContains(text) }
    }
    var body: some View {
        NavigationStack {
            Group {
                if models.count > 12 { form.searchable(text: $query, prompt: "Search models") }
                else { form }
            }
            .navigationTitle("Model & reasoning").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: done) } }
        }.nativeOptionsSheet()
            .sensoryFeedback(.selection, trigger: feedback) { _, _ in motion.active }
    }
    private var form: some View {
        Form {
            // Large OpenCode catalogs can contain hundreds of models. Keep
            // the selected model's effort reachable before that long list.
            if models.count > 12, query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { reasoningSection }
            Section("Model") {
                Picker("Model", selection: Binding(get: { chat.modelID }, set: { if chat.modelID != $0 { chat.chooseModel($0); feedback &+= 1 } })) {
                    Text("Task default").tag("")
                    // Keep a valid tag for a recorded model or a selection that
                    // is temporarily outside the search results.
                    if !chat.modelID.isEmpty, !filtered.contains(where: { $0.id == chat.modelID }) {
                        Text(activeModel?.label ?? chat.modelID).tag(chat.modelID)
                    }
                    ForEach(filtered) { Text($0.label).tag($0.id) }
                }.pickerStyle(.inline).labelsHidden()
                if !query.isEmpty, filtered.isEmpty { Text("No matching models").foregroundStyle(FD.secondary) }
            }.listRowBackground(FD.surface)
            if model.catalog(task).modelsLoading, models.isEmpty {
                Section { HStack(spacing: 10) { ActivityDiamond(); Text("Loading models…").foregroundStyle(FD.secondary) } }
                    .listRowBackground(FD.surface).accessibilityIdentifier("composer-models-loading")
            }
            if let error = model.catalog(task).modelsError {
                Section {
                    Text(error).font(.footnote).foregroundStyle(FD.secondary)
                    Button("Retry loading models") { Task { await model.loadModels(task, force: true) } }
                        .disabled(!model.connected || model.catalog(task).modelsLoading)
                }.listRowBackground(FD.surface)
            }
            if models.count <= 12 { reasoningSection }
        }.accessibilityIdentifier("composer-model-options").scrollContentBackground(.hidden).background(FD.background)
    }
    @ViewBuilder private var reasoningSection: some View {
        if let activeModel, !activeModel.efforts.isEmpty {
            if models.count > 12 {
                Section {
                    reasoningPicker(activeModel).pickerStyle(.menu)
                        .accessibilityIdentifier("composer-reasoning")
                        .accessibilityValue(chat.effort.isEmpty ? "Agent default" : chat.effort.capitalized)
                }.listRowBackground(FD.surface)
            } else {
                Section("Reasoning") { reasoningPicker(activeModel).pickerStyle(.inline).labelsHidden() }
                    .listRowBackground(FD.surface)
            }
        }
    }
    private func reasoningPicker(_ activeModel: AgentModel) -> some View {
        Picker("Reasoning", selection: Binding(get: { chat.effort }, set: { if chat.effort != $0 { chat.chooseEffort($0); feedback &+= 1 } })) {
            Text(activeModel.efforts.contains("default") ? "Agent default" : "Default").tag("")
            if !chat.effort.isEmpty, !activeModel.efforts.contains(chat.effort) { Text(chat.effort.capitalized).tag(chat.effort) }
            ForEach(activeModel.efforts, id: \.self) { Text($0.capitalized).tag($0) }
        }
    }
}
