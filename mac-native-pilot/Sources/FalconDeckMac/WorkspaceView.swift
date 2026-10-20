import AppKit
import SwiftUI

/// Projects remain in their own column; tasks have a second, independent
/// selection so moving between workspaces does not turn the sidebar into a tree.
struct WorkspaceView: View {
    @Bindable var store: AppStore
    @AppStorage("native.sidebar.visible") private var sidebarVisible = true
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showingSearch = false

    private var showsTaskColumn: Bool {
        ["project", "chats", "pins"].contains(store.selectedSection)
    }

    var body: some View {
        Group {
            if showsTaskColumn {
                NavigationSplitView(columnVisibility: $columnVisibility) {
                    ProjectNavigator(store: store)
                        .navigationSplitViewColumnWidth(min: 180, ideal: 218, max: 320)
                        .background(NativeSplitViewPersistence(name: "native.workspace.columns"))
                } content: {
                    TaskNavigator(store: store)
                        .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 460)
                } detail: {
                    MainWorkspaceView(store: store)
                        .frame(minWidth: 460)
                }
                .navigationSplitViewStyle(.balanced)
            } else {
                NavigationSplitView(columnVisibility: $columnVisibility) {
                    ProjectNavigator(store: store)
                        .navigationSplitViewColumnWidth(min: 180, ideal: 218, max: 320)
                        .background(NativeSplitViewPersistence(name: "native.workspace.main-columns"))
                } detail: {
                    MainWorkspaceView(store: store)
                        .frame(minWidth: 650)
                }
                .navigationSplitViewStyle(.balanced)
            }
        }
        .navigationTitle("FalconDeck")
        .tint(FDTheme.accent)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { showingSearch = true } label: {
                    Label("Search tasks and commands", systemImage: "magnifyingglass")
                }
                .help("Search tasks and commands (⌘K)")
                .accessibilityIdentifier("workspace-search")
                Button(action: newTask) {
                    Label("New task", systemImage: "square.and.pencil")
                }
                .help("New task (⌘N)")
                .disabled(!store.isConnected)
                .accessibilityIdentifier("new-task-toolbar")
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
            store.newTask()
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
