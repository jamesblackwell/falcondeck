import AppKit
import SwiftUI

/// One sidebar, the way the Tauri app arranges it: projects, pins and the open
/// project's own tasks in a single column beside the conversation.
struct WorkspaceView: View {
    @Bindable var store: AppStore
    @AppStorage("native.sidebar.visible") private var sidebarVisible = true
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showingSearch = false

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            ProjectNavigator(store: store)
                .navigationSplitViewColumnWidth(min: 240, ideal: 304, max: 440)
                .background(NativeSplitViewPersistence(name: "native.workspace.columns"))
        } detail: {
            MainWorkspaceView(store: store)
                .frame(minWidth: 520)
        }
        .navigationSplitViewStyle(.balanced)
        .navigationTitle("FalconDeck")
        .background(NativeWorkspaceWindowAnchor())
        .tint(FDTheme.accent)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { showingSearch = true } label: {
                    Label("Search tasks and commands", systemImage: "magnifyingglass")
                }
                .help("Search tasks and commands (⌘K)")
                .accessibilityIdentifier("workspace-search")
            }
        }
        .sheet(isPresented: $showingSearch) {
            WorkspaceSearch(store: store, close: { showingSearch = false })
        }
        .onAppear { columnVisibility = sidebarVisible ? .all : .detailOnly }
        .onChange(of: columnVisibility) { _, value in sidebarVisible = value != .detailOnly }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("native.command"))) { notification in
            guard let command = notification.object as? String else { return }
            switch command {
            case "commandPalette", "searchThreads", "openProjectMenu": showingSearch = true
            case "toggleSidebar": columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
            case "openProject": openProject()
            default: break
            }
        }
    }

    private func newTask() {
        if store.selectedSection == "chats" || store.selectedProject == nil {
            Task { await store.newChat() }
        } else {
            store.selectSection(store.selectedProject?.raw["kind"].string == "casual" ? "chats" : "project")
            store.newTask(focusComposer: true)
        }
    }

    private func openProject() {
        let panel = NSOpenPanel()
        panel.title = "Open project"; panel.prompt = "Open project"
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in await store.openProject(path: url.path) }
        }
    }
}

/// Auxiliary windows route task opens back to the workspace instead of leaving
/// the changed conversation hidden behind Activity or a notification popover.
@MainActor enum NativeWorkspaceWindow {
    static weak var window: NSWindow?
    static func show() {
        guard let window else { return }
        NSApp.activate(ignoringOtherApps: true)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
    }
}

private struct NativeWorkspaceWindowAnchor: NSViewRepresentable {
    func makeNSView(context: Context) -> Anchor { Anchor(frame: .zero) }
    func updateNSView(_ nsView: Anchor, context: Context) {}
    final class Anchor: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { NativeWorkspaceWindow.window = window }
        }
    }
}
