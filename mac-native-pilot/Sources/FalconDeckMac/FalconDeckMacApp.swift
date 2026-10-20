import SwiftUI

@main struct FalconDeckMacApp: App {
    @State private var store = AppStore()

    var body: some Scene {
        Window("FalconDeck Native", id: "workspace") {
            WorkspaceView(store: store)
                .frame(minWidth: 960, minHeight: 620)
                .preferredColorScheme(.dark)
                .task { await store.reconnect() }
        }
        .defaultSize(width: 1320, height: 860)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New task") { store.newTask() }
                    .keyboardShortcut("n", modifiers: .command)
                Button("Reconnect") { Task { await store.reconnect() } }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
            }
        }
    }
}
