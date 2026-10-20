import SwiftUI

struct MainWorkspaceView: View {
    @Bindable var store: AppStore

    private var conversation: Bool { ["project", "chats", "pins"].contains(store.selectedSection) }

    var body: some View {
        VStack(spacing: 0) {
            if conversation {
                VSplitView {
                    HSplitView {
                        ConversationView(store: store).frame(minWidth: 440)
                        if store.showInspector {
                            NativeInspectorView(store: store).frame(minWidth: 300, idealWidth: 380, maxWidth: 650)
                        }
                    }
                    if store.showTerminal {
                        NativeTerminalPanel(store: store, onHide: { store.showTerminal = false })
                            .frame(minHeight: 180, idealHeight: 250)
                    }
                }
            } else {
                switch store.selectedSection {
                case "activity": NativeActivityView(store: store)
                case "automations": NativeAutomationsView(store: store)
                case "usage": NativeUsageView(store: store)
                case "plugins": NativePluginsView(store: store)
                case "extensions": NativeExtensionsView(store: store).id("\(store.selectedHostID ?? "local"):extensions")
                case "settings": NativeSettingsView(store: store)
                case "extension-panel":
                    if let extensionID = store.selectedExtensionID, let panelID = store.selectedPanelID {
                        NativeExtensionPanel(store: store, extensionID: extensionID, panelID: panelID)
                            .id("\(store.selectedHostID ?? "local"):\(extensionID):\(panelID)")
                    }
                default: ConversationView(store: store)
                }
            }
        }
        .background(FDTheme.background)
        .toolbar {
            if conversation {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { store.showInspector.toggle() } label: { Image(systemName: "sidebar.right") }
                        .help("Info, changes and files")
                        .accessibilityLabel(store.showInspector ? "Hide inspector" : "Show inspector")
                    Button { store.showTerminal.toggle() } label: { Image(systemName: "terminal") }
                        .help("Terminal")
                        .accessibilityLabel(store.showTerminal ? "Hide terminal" : "Show terminal")
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .init("FalconDeckOpenExtensions"))) { _ in store.selectSection("extensions") }
        .onReceive(NotificationCenter.default.publisher(for: .init("FalconDeckShowConversation"))) { _ in store.selectSection("project") }
        .onReceive(NotificationCenter.default.publisher(for: .init("falcondeck.native.openSettingsSection"))) { _ in store.selectSection("settings") }
    }
}
