import SwiftUI

/// The mobile app opens into a conversation, with projects in the sidebar.
struct StartView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Group {
            if let project = model.defaultDraftProject {
                DraftConversationView(projectID: project.id, folderID: nil).id(project.id)
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
