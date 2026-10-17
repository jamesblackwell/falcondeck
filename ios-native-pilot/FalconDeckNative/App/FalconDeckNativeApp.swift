import SwiftUI

@main
struct FalconDeckNativeApp: App {
    @State private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(FD.accent)
                .task { await model.start() }
                .onOpenURL { url in
                    model.pairingText = url.absoluteString
                    model.showConnection = true
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar
    var body: some View {
        @Bindable var model = model
        NavigationSplitView(preferredCompactColumn: $compactColumn) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 380)
        } detail: {
            NavigationStack {
                switch model.selection {
                case .task(let id):
                    if let task = model.tasks.first(where: { $0.id == id }) {
                        ConversationView(task: task).id(id)
                    } else { ProjectsView() }
                case .draft(let projectID, let folderID): DraftConversationView(projectID: projectID, folderID: folderID)
                case .activity: ActivityView()
                case .archived: ArchivedTasksView()
                default: ProjectsView()
                }
            }.id(model.selection)
        }
        .navigationSplitViewStyle(.balanced)
        .sensoryFeedback(.selection, trigger: model.selection)
        .onChange(of: model.selection) { _, selection in
            if selection != nil && sizeClass == .compact { compactColumn = .detail }
        }
        .sheet(isPresented: $model.showConnection) { ConnectionView() }
        .sheet(item: Binding(get: { model.taskOptionsID.map { TaskOptionsTarget(id: $0) } }, set: { model.taskOptionsID = $0?.id })) { target in TaskOptionsView(taskID: target.id) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && model.hasSession && !model.demo { Task { await model.reconnect() } }
        }
    }
}

private struct TaskOptionsTarget: Identifiable { let id: String }
