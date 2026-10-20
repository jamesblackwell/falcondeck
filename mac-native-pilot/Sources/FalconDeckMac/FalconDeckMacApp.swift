import SwiftUI

struct FalconDeckMacApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @NSApplicationDelegateAdaptor(RuntimeLifecycle.self) private var runtimeLifecycle
    @State private var store = AppStore()
    @Bindable private var preferences = NativePreferences.shared
    @State private var showWelcome = !UserDefaults.standard.bool(forKey: "falcondeck.native.onboarding.complete")

    var body: some Scene {
        Window("FalconDeck Native", id: "workspace") {
            WorkspaceView(store: store)
                .frame(minWidth: 960, minHeight: 620)
                .preferredColorScheme(preferences.preferredColorScheme)
                .font(preferences.font(size: 13))
                .task {
                    runtimeLifecycle.store = store
                    NativeCommandDispatcher.shared.attach(store: store)
                    NativeSpeechController.shared.attach(store: store)
                    NativePlatform.shared.attach(store: store, currentHost: { store.selectedHostID }, route: { host, _, task in
                        let id = host.map { NativeHostManager.namespace(hostID: $0, id: task) } ?? task
                        await store.selectTask(id)
                        NSApp.activate(ignoringOtherApps: true)
                    })
                    await store.reconnect()
                }
                .sheet(isPresented: $showWelcome) { NativeWelcomeSetupView(store: store, onComplete: { showWelcome = false }) }
                .onChange(of: scenePhase) { _, phase in
                    Task { await NativeHostManager.shared.setForeground(phase == .active) }
                    if phase == .active { store.markSelectedTaskRead() }
                }
        }
        .defaultSize(width: 1320, height: 860)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { store.selectSection("settings") }
                    .keyboardShortcut(NativeCommandDispatcher.menuShortcut(for: "openSettings", preferences: preferences))
            }
            CommandGroup(after: .newItem) {
                Button("New task") { store.newTask() }
                    .keyboardShortcut(NativeCommandDispatcher.menuShortcut(for: "newThread", preferences: preferences))
                Button("New chat") { Task { await store.newChat() } }
                    .keyboardShortcut(NativeCommandDispatcher.menuShortcut(for: "newChat", preferences: preferences))
                Button("Reconnect") { Task { await store.reconnect() } }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
            }
            CommandMenu("Workspace") {
                Button("Search tasks and commands") { NativeCommandDispatcher.shared.execute("commandPalette") }
                    .keyboardShortcut(NativeCommandDispatcher.menuShortcut(for: "commandPalette", preferences: preferences))
                Button("Activity") { store.selectSection("activity") }
                    .keyboardShortcut(NativeCommandDispatcher.menuShortcut(for: "openActivity", preferences: preferences))
                Button("Automations") { store.selectSection("automations") }
                Button("Usage") { store.selectSection("usage") }
                    .keyboardShortcut(NativeCommandDispatcher.menuShortcut(for: "openUsage", preferences: preferences))
                Divider()
                Button("Toggle sidebar") { NativeCommandDispatcher.shared.execute("toggleSidebar") }
                    .keyboardShortcut(NativeCommandDispatcher.menuShortcut(for: "toggleSidebar", preferences: preferences))
                Toggle("Show inspector", isOn: $store.showInspector)
                    .keyboardShortcut(NativeCommandDispatcher.menuShortcut(for: "toggleChanges", preferences: preferences))
                Toggle("Show terminal", isOn: $store.showTerminal)
                    .keyboardShortcut(NativeCommandDispatcher.menuShortcut(for: "toggleTerminal", preferences: preferences))
            }
        }
    }
}
