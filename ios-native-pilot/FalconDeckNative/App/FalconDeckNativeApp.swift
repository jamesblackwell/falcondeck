import SwiftUI

@main
struct FalconDeckNativeApp: App {
    @State private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(NativeAppearance.shared.colorScheme)
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
    @Environment(\.dynamicTypeSize) private var textSize
    @AppStorage("native.debug.overlay") private var showPerformance = false
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
                case .settings: SettingsView()
                case .automations: AutomationsView()
                default: ProjectsView()
                }
            }.id(model.selection)
        }
        .navigationSplitViewStyle(.balanced)
        .dynamicTypeSize(NativeAppearance.shared.textSize(relativeTo: textSize))
        .sensoryFeedback(.selection, trigger: model.selection)
        .onChange(of: model.selection) { _, selection in
            if selection != nil && sizeClass == .compact { compactColumn = .detail }
        }
        .sheet(isPresented: $model.showConnection) { ConnectionView() }
        .sheet(isPresented: $model.showSpeechSettings) { NavigationStack { SpeechSettingsView(modal: true) } }
        .overlay(alignment: .topTrailing) { if showPerformance { PerformanceOverlay() } }
        .sheet(item: Binding(get: { model.taskOptionsID.map { TaskOptionsTarget(id: $0) } }, set: { model.taskOptionsID = $0?.id })) { target in TaskOptionsView(taskID: target.id) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && model.hasSession && !model.demo { Task { if model.connected { await model.refresh() } else { await model.reconnect() } } }
        }
    }
}

private struct TaskOptionsTarget: Identifiable { let id: String }
