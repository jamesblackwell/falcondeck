import SwiftUI

/// The mobile app opens into a conversation, with projects in the sidebar.
struct StartView: View {
    @Environment(AppModel.self) private var model
    @State private var projectID = ""
    private var project: Project? { model.projects.first { $0.id == projectID } ?? model.sortedProjects.first { $0.raw["kind"].string == "casual" } ?? model.sortedProjects.first }
    var body: some View {
        Group {
            if let project {
                DraftConversationView(projectID: project.id, folderID: nil).id(project.id)
                    .toolbar {
                        ToolbarItem(placement: .principal) {
                            Menu {
                                ForEach(model.sortedProjects) { project in Button(project.name) { projectID = project.id } }
                                Button("New chat", systemImage: "square.and.pencil") { Task { await model.newChat() } }
                            } label: { HStack(spacing: 6) { Text(project.raw["kind"].string == "casual" ? "New chat" : project.name).lineLimit(1); Image(systemName: "chevron.down").font(.caption2) }.font(.subheadline.weight(.semibold)) }
                        }
                    }
            } else {
                VStack(spacing: 20) {
                    ContentUnavailableView("Your agents, anywhere", systemImage: "laptopcomputer.and.iphone", description: Text("Connect to your computer to open your projects and conversations."))
                    Button("Connect a computer") { model.showConnection = true }.buttonStyle(.glassProminent)
                    Button("Explore demo") { Task { await model.useDemo() } }.buttonStyle(.glass)
                }.padding().frame(maxWidth: .infinity, maxHeight: .infinity).background(FD.background).navigationTitle("FalconDeck")
            }
        }
    }
}
