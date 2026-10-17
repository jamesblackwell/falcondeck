import SwiftUI

struct NewTaskView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var projectID = ""
    @State private var provider = "codex"
    @State private var modelID = ""
    @State private var creating = false
    @State private var error: String?
    private var project: Project? { model.projects.first { $0.id == projectID } }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("A fresh space to work with your agent.", systemImage: "square.and.pencil")
                        .font(.headline).padding(.vertical, 12)
                }.listRowBackground(FD.surface)
                Section("Task") {
                    Picker("Project", selection: $projectID) {
                        ForEach(model.sortedProjects) { Text($0.name).tag($0.id) }
                    }
                    Picker("Agent", selection: $provider) {
                        ForEach(project?.providers ?? ["codex"], id: \.self) { Text($0.capitalized).tag($0) }
                    }
                    Picker("Model", selection: $modelID) {
                        Text("Agent default").tag("")
                        ForEach(project?.models(for: provider) ?? []) { Text($0.label).tag($0.id) }
                    }
                    if let folder = model.folders.first(where: { $0.id == model.newTaskFolderID && $0.projectID == projectID }) {
                        LabeledContent("Folder", value: folder.name)
                    }
                }.listRowBackground(FD.surface)
                if let error { Section { Text(error).foregroundStyle(.orange) }.listRowBackground(FD.surface) }
                Section {
                    Button {
                        guard let project else { return }
                        creating = true; error = nil
                        Task {
                            defer { creating = false }
                            do {
                                try await model.createTask(project: project, provider: provider, modelID: modelID, folderID: projectID == model.newTaskProjectID ? model.newTaskFolderID : nil)
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    } label: {
                        HStack { Text(creating ? "Creating task…" : "Create task"); Spacer(); if creating { ActivityDiamond() } }
                    }.disabled(creating || project == nil || (!model.demo && !model.connected)).accessibilityIdentifier("create-task")
                }.listRowBackground(FD.surface)
            }
            .scrollContentBackground(.hidden).background(FD.background)
            .navigationTitle("New task").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(creating) } }
            .onAppear {
                projectID = model.newTaskProjectID ?? model.sortedProjects.first?.id ?? ""
                provider = project?.defaultProvider ?? "codex"
            }
            .onChange(of: projectID) { _, _ in provider = project?.defaultProvider ?? "codex"; modelID = "" }
            .onChange(of: provider) { _, _ in modelID = "" }
        }
        .presentationDetents([.large]).presentationDragIndicator(.visible).interactiveDismissDisabled(creating)
    }
}
