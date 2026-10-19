import SwiftUI

struct DraftProjectPicker: View {
    @Environment(AppModel.self) private var model
    @State private var presented = false
    let title: String
    var body: some View {
        Button { presented = true } label: {
            ConversationTitleLabel(title: title, projectPicker: true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose project").accessibilityValue(title)
        .accessibilityHint("Unsent drafts are kept separately for each project.")
        .accessibilityIdentifier("draft-project-picker")
        .sheet(isPresented: $presented) { DraftProjectList() }
    }
}

private struct DraftProjectList: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    private var filtered: [Project] { model.sortedProjects.filter { search.isEmpty || $0.name.localizedStandardContains(search) || $0.path.localizedStandardContains(search) } }
    var body: some View {
        NavigationStack {
            List {
                ForEach(filtered) { project in
                    Button {
                        model.selectDraftProject(project.id); dismiss()
                    } label: {
                        HStack(spacing: 12) {
                            WorkspaceGlyph(project: project).frame(width: 22, height: 22)
                            Text(project.raw["kind"].string == "casual" ? "Chats" : project.name).foregroundStyle(FD.foreground).lineLimit(1)
                            Spacer(minLength: 8)
                            if model.selectedDraftProject?.id == project.id { Image(systemName: "checkmark").foregroundStyle(FD.accent) }
                        }.frame(minHeight: 32).contentShape(.rect)
                    }.listRowBackground(FD.surface).accessibilityIdentifier("choose-project-" + project.id)
                }
                if search.isEmpty, !model.projects.contains(where: { $0.raw["kind"].string == "casual" }) {
                    Button("New chat", systemImage: "square.and.pencil") {
                        Task { if let project = await model.newChat() { model.revealDetail(.draft(project.id, nil)); dismiss() } }
                    }.disabled(!model.demo && !model.connected).listRowBackground(FD.surface)
                }
            }
            .scrollContentBackground(.hidden).background(FD.background)
            .contentMargins(.top, 8, for: .scrollContent)
            .safeAreaInset(edge: .top, spacing: 0) {
                NativeSearchField(text: $search, prompt: "Search projects")
                    .frame(minHeight: 44).padding(.horizontal, 20).padding(.bottom, 8).background(FD.background)
            }
            .overlay { if !search.isEmpty && filtered.isEmpty { ContentUnavailableView.search(text: search).allowsHitTesting(false) } }
            .navigationTitle("Choose project").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDetents([.medium, .large])
    }
}
