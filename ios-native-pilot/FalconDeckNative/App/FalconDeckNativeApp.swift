import SwiftUI

@main
struct FalconDeckNativeApp: App {
    @UIApplicationDelegateAdaptor(NativeAppDelegate.self) private var appDelegate
    @State private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(NativeAppearance.shared.colorScheme)
                .tint(FD.accent)
                .task { await model.start() }
                .onOpenURL { url in
                    if url.host == "speech" { if model.voice.pendingURL != nil { model.showSpeechSettings = true } }
                    else { Task { await model.receivePairingPayload(url.absoluteString) } }
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
        Group {
            if model.restoringSession {
                ProgressView("Connecting…").frame(maxWidth: .infinity, maxHeight: .infinity).background(FD.background)
            } else if !model.demo && (!model.hasSession || model.pairingPending) {
                ConnectionView(onboarding: true)
            } else {
                workspace
            }
        }
        .sheet(isPresented: Binding(get: { model.showConnection && !model.pairingPending && (model.hasSession || model.demo) }, set: { model.showConnection = $0 })) { ConnectionView() }
        .sheet(isPresented: $model.showSpeechSettings) { NavigationStack { SpeechSettingsView(modal: true) } }
        .overlay(alignment: .topTrailing) { if showPerformance { PerformanceOverlay() } }
        .sheet(item: Binding(get: { model.taskOptionsID.map { TaskOptionsTarget(id: $0) } }, set: { model.taskOptionsID = $0?.id })) { target in TaskOptionsView(taskID: target.id) }
        .onChange(of: scenePhase) { _, phase in model.setForeground(phase == .active) }
    }

    private var workspace: some View {
        NavigationSplitView(preferredCompactColumn: $compactColumn) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 380)
        } detail: {
            NavigationStack {
                switch model.selection {
                case .task(let id):
                    if let task = model.task(id) {
                        ConversationView(task: task).id(id)
                    } else { StartView() }
                case .draft(let projectID, let folderID): DraftConversationView(projectID: projectID, folderID: folderID)
                case .activity: ActivityView()
                case .archived: ArchivedTasksView()
                case .settings: SettingsView()
                case .automations: AutomationsView()
                default: StartView()
                }
            }.id(model.selection).navigationBarTitleDisplayMode(.inline)
        }
        .navigationSplitViewStyle(.balanced)
        .dynamicTypeSize(NativeAppearance.shared.textSize(relativeTo: textSize))
        .sensoryFeedback(.selection, trigger: model.selection)
        // Sidebar rows are plain buttons so UIKit does not add disclosure
        // chevrons. This binding owns their compact push into the detail pane.
        .onChange(of: model.selection) { _, selection in
            if selection != nil && sizeClass == .compact { compactColumn = .detail }
        }
    }
}

private struct TaskOptionsTarget: Identifiable { let id: String }
