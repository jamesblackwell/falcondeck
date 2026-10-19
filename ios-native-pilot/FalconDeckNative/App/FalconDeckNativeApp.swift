import AppIntents
import SwiftUI

@main
struct FalconDeckNativeApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @UIApplicationDelegateAdaptor(NativeAppDelegate.self) private var appDelegate
    @State private var model: AppModel
    init() {
        let model = Self.makeModel()
        _model = State(initialValue: model)
        AppDependencyManager.shared.add(dependency: NativeIntentContext(model: model))
    }
    static var isUnitTestHost: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["XCTestBundlePath"]?.hasSuffix("/FalconDeckNativeTests.xctest") == true
        #else
        false
        #endif
    }
    static func makeModel() -> AppModel {
        #if DEBUG
        if isUnitTestHost {
            let suite = "NativeUnitTestHost", defaults = UserDefaults(suiteName: suite)!
            defaults.removePersistentDomain(forName: suite)
            let model = AppModel(relay: UnavailablePreviewRelay(), voice: VoiceRecorder(defaults: defaults), push: NativePushNotifications(defaults: defaults), notifications: LocalNotifications(defaults: defaults), sessionLoader: { nil })
            model.restoringSession = false
            return model
        }
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--loading-preview=") }) {
            let defaults = UserDefaults(suiteName: "NativeLoadingPreview")!
            defaults.removePersistentDomain(forName: "NativeLoadingPreview")
            return AppModel(relay: LoadingPreviewRelay(failFirst: ProcessInfo.processInfo.arguments.contains("--loading-preview=retry")), voice: VoiceRecorder(defaults: defaults), push: NativePushNotifications(defaults: defaults), notifications: LocalNotifications(defaults: defaults), sessionLoader: { nil })
        }
        if ProcessInfo.processInfo.arguments.contains("--review-preview=offline") || ProcessInfo.processInfo.arguments.contains("--review-preview=queue-error") {
            let suite = "NativeReviewPreview", defaults = UserDefaults(suiteName: "NativeReviewPreview")!
            defaults.removePersistentDomain(forName: suite)
            return AppModel(relay: UnavailablePreviewRelay(), voice: VoiceRecorder(defaults: defaults), push: NativePushNotifications(defaults: defaults), notifications: LocalNotifications(defaults: defaults), sessionLoader: { nil })
        }
        if ProcessInfo.processInfo.arguments.contains("--demo") {
            let suite = "NativeDemoPreview", defaults = UserDefaults(suiteName: suite)!
            defaults.removePersistentDomain(forName: suite)
            if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--image-preview=") }) {
                return AppModel(relay: ImagePreviewRelay(), voice: VoiceRecorder(defaults: defaults), push: NativePushNotifications(defaults: defaults), notifications: LocalNotifications(defaults: defaults), sessionLoader: { nil })
            }
            return AppModel(voice: VoiceRecorder(defaults: defaults), push: NativePushNotifications(defaults: defaults), notifications: LocalNotifications(defaults: defaults), sessionLoader: { nil })
        }
        #endif
        return AppModel()
    }
    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .modifier(NativeMotionScope())
                .preferredColorScheme(NativeAppearance.shared.colorScheme)
                .tint(FD.accent)
                .task {
                    if !Self.isUnitTestHost {
                        await model.start()
                        if !model.demo { FalconNativeShortcuts.updateAppShortcutParameters() }
                    }
                }
                .onOpenURL { url in
                    if url.scheme == "falcondeck-native", url.host == "task" { Task { await model.openTaskActivity(url) } }
                    else if url.host == "speech" { if model.voice.pendingURL != nil { model.showSpeechSettings = true } }
                    else { Task { await model.receivePairingPayload(url.absoluteString) } }
                }
        }
        // App-level phase aggregates iPad windows. Closing one scene must not
        // mark an actively used second window as backgrounded.
        .onChange(of: scenePhase) { _, phase in
            model.setForeground(phase == .active)
            if phase == .background { model.saveBeforeSuspension() }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.nativeMotion) private var motion
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dynamicTypeSize) private var textSize
    @AppStorage("native.debug.overlay") private var showPerformance = false
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var detailPath: [DetailDestination] = []
    var body: some View {
        @Bindable var model = model
        Group {
            if model.restoringSession {
                NativeLoadingState(label: "Connecting…").frame(maxWidth: .infinity, maxHeight: .infinity).background(FD.background)
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
        .sensoryFeedback(.selection, trigger: model.taskOptionsID) { _, id in id != nil && motion.active }
        // Keep presented sheets on the same appearance and menu policy.
        .menuOrder(.fixed)
        .dynamicTypeSize(NativeAppearance.shared.textSize(relativeTo: textSize))
    }

    private var workspace: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $compactColumn) {
            SidebarView {
                if sizeClass == .compact { compactColumn = .detail }
            }
                .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 380)
        } detail: {
            // Keep the navigation controller stable while the compact column
            // opens. Replacing the stack can deliver disappearance to the new
            // transcript, cancelling its initial scroll and read acknowledgement.
            NavigationStack(path: $detailPath) {
                ZStack { destination.id(model.selection) }
                    // Keep the root title's preference provider stable too;
                    // a removed destination can otherwise clear the new title.
                    .navigationTitle(detailTitle)
                    .toolbarBackgroundVisibility(floatingConversationHeader ? .hidden : .automatic, for: .navigationBar)
                    .toolbar {
                        if floatingConversationHeader {
                            ToolbarItem(placement: .principal) {
                                if model.isNewConversation {
                                    DraftProjectPicker(title: detailTitle)
                                } else {
                                    Text(detailTitle)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(FD.foreground)
                                        .lineLimit(1).truncationMode(.tail)
                                        .padding(.horizontal, 14).padding(.vertical, 8)
                                        .glassEffect(.regular, in: .capsule)
                                        .accessibilityIdentifier("conversation-title")
                                }
                            }
                        }
                    }
                    .navigationDestination(for: DetailDestination.self) { $0.view }
            }.navigationBarTitleDisplayMode(.inline)
        }
        .navigationSplitViewStyle(.balanced)
        .onAppear {
            if sizeClass == .compact {
                // A cold-launch Intent may select its destination before this
                // workspace appears. Default launches still open the sidebar.
                switch model.selection { case .projects, nil: break; default: compactColumn = .detail }
            }
        }
        .sensoryFeedback(.selection, trigger: model.selection) { _, _ in motion.active }
        // Sidebar taps also reveal an unchanged selection. This observer handles
        // destinations opened elsewhere, including incoming notifications.
        .onChange(of: model.selection) { _, selection in
            var reset = Transaction(); reset.disablesAnimations = true
            withTransaction(reset) { detailPath.removeAll() }
            if selection != nil && sizeClass == .compact { compactColumn = .detail }
        }
        .onChange(of: model.detailRequestID) { _, _ in
            var reset = Transaction(); reset.disablesAnimations = true
            withTransaction(reset) { detailPath.removeAll() }
            if sizeClass == .compact { compactColumn = .detail }
        }
    }
    private var floatingConversationHeader: Bool {
        guard detailPath.isEmpty else { return false }
        switch model.selection {
        case .task, .draft, .projects, nil: return true
        default: return false
        }
    }
    private var detailTitle: String {
        switch model.selection {
        case .task(let id): model.task(id)?.title.nonempty ?? "New task"
        case .draft(let projectID, _): projectTitle(model.projects.first { $0.id == projectID })
        case .activity: "Activity"
        case .archived: "Archived tasks"
        case .settings: "Settings"
        case .automations: "Automations"
        case .projects, nil: projectTitle(model.sortedProjects.first { $0.raw["kind"].string == "casual" } ?? model.sortedProjects.first)
        }
    }
    private func projectTitle(_ project: Project?) -> String {
        guard let project else { return "FalconDeck" }
        return project.raw["kind"].string == "casual" ? "New chat" : project.name
    }
    @ViewBuilder private var destination: some View {
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
    }
}

private struct TaskOptionsTarget: Identifiable { let id: String }
