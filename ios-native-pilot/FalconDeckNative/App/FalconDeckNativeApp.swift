import SwiftUI

@main
struct FalconDeckNativeApp: App {
    @UIApplicationDelegateAdaptor(NativeAppDelegate.self) private var appDelegate
    @State private var model = makeModel()
    private static func makeModel() -> AppModel {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--loading-preview=") }) {
            let defaults = UserDefaults(suiteName: "NativeLoadingPreview")!
            defaults.removePersistentDomain(forName: "NativeLoadingPreview")
            return AppModel(relay: LoadingPreviewRelay(failFirst: ProcessInfo.processInfo.arguments.contains("--loading-preview=retry")), push: NativePushNotifications(defaults: defaults), notifications: LocalNotifications(defaults: defaults), sessionLoader: { nil })
        }
        if ProcessInfo.processInfo.arguments.contains("--review-preview=offline") || ProcessInfo.processInfo.arguments.contains("--review-preview=queue-error") {
            let suite = "NativeReviewPreview", defaults = UserDefaults(suiteName: "NativeReviewPreview")!
            defaults.removePersistentDomain(forName: suite)
            return AppModel(relay: UnavailablePreviewRelay(), push: NativePushNotifications(defaults: defaults), notifications: LocalNotifications(defaults: defaults), sessionLoader: { nil })
        }
        #endif
        return AppModel()
    }
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
        // Keep presented sheets on the same appearance and menu policy.
        .menuOrder(.fixed)
        .dynamicTypeSize(NativeAppearance.shared.textSize(relativeTo: textSize))
    }

    private var workspace: some View {
        NavigationSplitView(preferredCompactColumn: $compactColumn) {
            SidebarView {
                if sizeClass == .compact { compactColumn = .detail }
            }
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
        .sensoryFeedback(.selection, trigger: model.selection)
        // Sidebar taps also reveal an unchanged selection. This observer handles
        // destinations opened elsewhere, including incoming notifications.
        .onChange(of: model.selection) { _, selection in
            if selection != nil && sizeClass == .compact { compactColumn = .detail }
        }
    }
}

private struct TaskOptionsTarget: Identifiable { let id: String }
