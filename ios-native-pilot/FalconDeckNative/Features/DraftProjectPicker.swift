import SwiftUI

struct DraftProjectPicker: View {
    @Environment(AppModel.self) private var model
    @State private var presented = false
    let title: String
    var body: some View {
        Button { presented = true } label: {
            HStack(spacing: 6) {
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(1).truncationMode(.tail)
                Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(FD.secondary)
            }
            .foregroundStyle(FD.foreground).padding(.horizontal, 14).frame(minHeight: 44)
            .glassEffect(.regular.interactive(), in: .capsule)
        }
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
            .searchable(text: $search, prompt: "Search projects")
            .overlay { if !search.isEmpty && filtered.isEmpty { ContentUnavailableView.search(text: search).allowsHitTesting(false) } }
            .navigationTitle("Choose project").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDetents([.medium, .large])
    }
}
