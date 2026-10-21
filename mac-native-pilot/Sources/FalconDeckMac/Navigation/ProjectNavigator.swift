import AppKit
import SwiftUI

/// The app-wide column. Tasks stay in the next column, while global pins can
/// be opened directly without changing the selected project first.
struct ProjectNavigator: View {
    @Bindable var store: AppStore
    @AppStorage("native.navigation.showHiddenProjects") private var showHidden = false
    @AppStorage("native.navigation.pinsExpanded") private var pinsExpanded = true
    @AppStorage("native.navigation.projectsExpanded") private var projectsExpanded = true
    @AppStorage("native.tasks.sort") private var sort = "last_updated"
    @State private var showingLibrary = false
    @State private var iconProject: Project?
    @State private var iconDomain = ""
    @State private var iconError: String?
    @State private var isSavingIcon = false
    @State private var busyProjects: Set<String> = []
    @State private var pinnedOrder: [String] = []
    @State private var ordering = NativeTaskNavigationOrder()
    @State private var renamingTask: AgentTask?

    private var hiddenIDs: Set<String> {
        Set(store.navigationPreferences["hidden_workspace_ids"].array.map(\.string))
    }

    private var orderedProjects: [Project] {
        let order = store.navigationPreferences["workspace_order"].array.map(\.string)
        let rank = Dictionary(order.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: min)
        return store.projects.enumerated().sorted { lhs, rhs in
            let left = rank[lhs.element.id] ?? (order.count + lhs.offset)
            let right = rank[rhs.element.id] ?? (order.count + rhs.offset)
            return left < right
        }.map(\.element)
    }

    private var pinCandidates: [AgentTask] {
        store.tasks.filter { $0.pinned && !$0.raw["is_archived"].bool }
    }

    private func pinnedTasks(_ candidates: [AgentTask]) -> [AgentTask] {
        let byID = Dictionary(candidates.map { ($0.id, $0) }, uniquingKeysWith: { _, rhs in rhs })
        let ordered = Set(pinnedOrder)
        return pinnedOrder.compactMap { byID[$0] } + candidates.filter { !ordered.contains($0.id) }
    }

    private var selection: Binding<String?> {
        Binding(get: {
            if store.selectedSection == "extension-panel", let extensionID = store.selectedExtensionID, let panelID = store.selectedPanelID {
                return "panel:\(extensionID):\(panelID)"
            }
            if ["project", "chats", "pins"].contains(store.selectedSection),
               let task = store.selectedTask, task.pinned, !task.raw["is_archived"].bool {
                let id = task.id
                return "task:\(id)"
            }
            if store.selectedSection == "project", let id = store.selectedProjectID {
                return "project:\(id)"
            }
            return "section:\(store.selectedSection)"
        }, set: { value in
            guard let value else { return }
            if value.hasPrefix("project:") {
                store.selectProject(String(value.dropFirst(8)))
            } else if value.hasPrefix("panel:") {
                let parts = value.dropFirst(6).split(separator: ":", maxSplits: 1).map(String.init)
                if parts.count == 2 { store.selectExtensionPanel(extensionID: parts[0], panelID: parts[1]) }
            } else if value.hasPrefix("task:") {
                Task { await store.selectTask(String(value.dropFirst(5)), preservePinScope: false) }
            } else if value.hasPrefix("section:") {
                store.selectSection(String(value.dropFirst(8)))
            }
        })
    }

    var body: some View {
        let summary = NativeProjectNavigationSummary(projects: store.allProjects, tasks: store.tasks)
        let pins = pinnedTasks(summary.pinCandidates)
        let hidden = hiddenIDs
        let projects = orderedProjects.filter { showHidden || !hidden.contains($0.id) }
        // Streaming previews redraw rows without changing their order.
        let pinOrderKey = summary.pinCandidates.map(NativeTaskNavigationOrder.key)
        return VStack(spacing: 0) {
            List(selection: selection) {
                Section {
                    navigationRow("Chats", symbol: "bubble.left.and.bubble.right", section: "chats",
                                  count: summary.chatCount)
                    navigationRow("Activity", symbol: "tray", section: "activity",
                                  count: summary.attentionCount)
                }

                Section {
                    if pinsExpanded {
                        ForEach(pins) { task in
                            pinnedTaskRow(task)
                                .tag("task:\(task.id)")
                        }
                    }
                } header: {
                    HStack(spacing: 4) {
                        sectionHeader("Pinned", expanded: $pinsExpanded)
                        Spacer(minLength: 0)
                        pinnedOptionsMenu
                    }
                }

                Section {
                    if projectsExpanded {
                        ForEach(projects) { project in
                            projectRow(project, taskCount: summary.projectCounts[project.id, default: 0],
                                       running: summary.runningProjectIDs.contains(project.id), hidden: hidden.contains(project.id))
                                .tag("project:\(project.id)")
                                .draggable("falcondeck-project:\(project.id)")
                                .dropDestination(for: String.self) { items, _ in
                                    guard let value = items.first,
                                          value.hasPrefix("falcondeck-project:") else { return false }
                                    moveProject(String(value.dropFirst(19)), before: project.id)
                                    return true
                                }
                        }
                        if projects.isEmpty {
                            Text(store.isConnected ? "Open a folder to add a project." : "Connecting to your Mac…")
                                .font(NativePreferences.shared.font(size: 13, surface: "sidebar"))
                                .foregroundStyle(FDTheme.muted)
                                .padding(.vertical, 6)
                                .listRowSeparator(.hidden)
                        }
                    }
                } header: {
                    HStack(spacing: 4) {
                        sectionHeader("Projects", expanded: $projectsExpanded)
                        Spacer(minLength: 0)
                        projectOptionsMenu
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 26)

            optionsFooter
        }
        .background(FDTheme.surface)
        .sheet(isPresented: $showingLibrary) {
            ProjectLibrarySheet(store: store)
        }
        .sheet(item: $iconProject) { project in
            iconWebsiteSheet(project)
        }
        .sheet(item: $renamingTask) { task in
            NativeTaskRenameSheet(store: store, task: task, dismiss: { renamingTask = nil })
        }
        .onAppear(perform: refreshPinOrder)
        .onChange(of: pinOrderKey) { _, _ in refreshPinOrder() }
        .onChange(of: sort) { _, _ in refreshPinOrder() }
    }

    private func navigationRow(_ title: String, symbol: String, section: String, count: Int = 0) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).frame(width: 18).foregroundStyle(FDTheme.muted)
            Text(title).lineLimit(1)
            Spacer(minLength: 0)
            if count > 0 {
                Text("\(count)").font(NativePreferences.shared.font(size: 12, surface: "sidebar", weight: .medium).monospaced())
                    .foregroundStyle(FDTheme.subtle)
            }
        }
        .font(NativePreferences.shared.font(size: 13, surface: "sidebar"))
        .padding(.vertical, 3)
        .tag("section:\(section)")
        .accessibilityIdentifier("navigation-\(section)")
    }

    private func sectionHeader(_ title: String, expanded: Binding<Bool>) -> some View {
        Button { expanded.wrappedValue.toggle() } label: {
            HStack(spacing: 5) {
                Image(systemName: expanded.wrappedValue ? "chevron.down" : "chevron.right")
                    .font(NativePreferences.shared.font(size: 8, surface: "sidebar", weight: .semibold))
                Text(title).font(NativePreferences.shared.font(size: 12, surface: "sidebar", weight: .medium))
            }
            .foregroundStyle(FDTheme.subtle)
            .padding(.vertical, 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(expanded.wrappedValue ? "Collapse" : "Expand") \(title)")
    }

    private func pinnedTaskRow(_ task: AgentTask) -> some View {
        HStack(spacing: 10) {
            TaskStatusMark(status: task.status).frame(width: 18)
            Text(task.title)
                .font(NativePreferences.shared.font(size: 13, surface: "sidebar", weight: task.unread ? .medium : .regular))
                .foregroundStyle(FDTheme.foreground)
                .lineLimit(1)
            Spacer(minLength: 0)
            if task.unread {
                Circle().fill(FDTheme.info).frame(width: 5, height: 5)
                    .accessibilityLabel("Unread")
            }
        }
        .padding(.vertical, 2)
        .help(task.title)
        .contextMenu {
            NativeTaskContextMenu(store: store, task: task, rename: { renamingTask = task })
        }
    }

    private func projectRow(_ project: Project, taskCount: Int, running: Bool, hidden: Bool) -> some View {
        HStack(spacing: 10) {
            ProjectNavigatorGlyph(store: store, project: project, preference: store.navigationPreferences["workspace_icons"][project.id],
                                  color: projectColor(project.id))
            Text(project.name).font(NativePreferences.shared.font(size: 13, surface: "sidebar")).lineLimit(1)
                .foregroundStyle(hidden ? FDTheme.muted : FDTheme.foreground)
            Spacer(minLength: 0)
            if busyProjects.contains(project.id) || running {
                MacActivityDiamond(size: 7)
            } else if hidden {
                Image(systemName: "eye.slash").font(NativePreferences.shared.font(size: 11, surface: "sidebar")).foregroundStyle(FDTheme.subtle)
            } else {
                Text("\(taskCount)").font(NativePreferences.shared.font(size: 11, surface: "sidebar").monospaced())
                    .foregroundStyle(FDTheme.subtle)
            }
        }
        .padding(.vertical, 3)
        .help(project.path)
        .accessibilityIdentifier("project-\(project.name)")
        .contextMenu {
            Button("Show in Finder", systemImage: "folder") {
                NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: project.path)
            }
            .disabled(NativeHostManager.split(project.id).hostID != nil)
            Button("Copy project path", systemImage: "doc.on.doc") { FDTheme.copy(project.path) }
            Divider()
            Menu("Project icon") {
                Button("Automatic") { saveIcon(project.id, value: nil) }
                Button("Folder") { saveIcon(project.id, value: .object(["mode": .string("folder")])) }
                Button("Website…") {
                    iconDomain = store.navigationPreferences["workspace_icons"][project.id]["domain"].string
                    iconError = nil
                    iconProject = project
                }
            }
            Menu("Project color") {
                Button("Default") { saveMapPreference("workspace_colors", id: project.id, value: nil) }
                ForEach(ProjectCategoryColor.all) { category in
                    Button {
                        saveMapPreference("workspace_colors", id: project.id, value: .string(category.id))
                    } label: {
                        Label(category.name, systemImage: store.navigationPreferences["workspace_colors"][project.id].string == category.id ? "checkmark.circle.fill" : "circle.fill")
                            .foregroundStyle(category.color)
                    }
                }
            }
            Button(hidden ? "Show project" : "Hide project", systemImage: hidden ? "eye" : "eye.slash") {
                var ids = store.navigationPreferences["hidden_workspace_ids"].array.map(\.string)
                if hidden { ids.removeAll { $0 == project.id } }
                else if !ids.contains(project.id) { ids.append(project.id) }
                savePreferences(.object(["hidden_workspace_ids": .array(ids.map(JSON.string))]), hostID: NativeHostManager.split(project.id).hostID)
            }
            Menu("Move project") {
                Button("Move to top") { moveProject(project.id, before: orderedProjects.first?.id) }
                    .disabled(orderedProjects.first?.id == project.id)
                Button("Move up") { moveProjectBy(project.id, offset: -1) }
                    .disabled(orderedProjects.first?.id == project.id)
                Button("Move down") { moveProjectBy(project.id, offset: 1) }
                    .disabled(orderedProjects.last?.id == project.id)
                Button("Move to bottom") { moveProject(project.id, before: nil) }
                    .disabled(orderedProjects.last?.id == project.id)
            }
            Divider()
            Button("Remove from Sidebar", systemImage: "sidebar.left") { closeProject(project) }
            Button("Forget project…", systemImage: "trash", role: .destructive) { forgetProject(project) }
        }
        .disabled(busyProjects.contains(project.id))
    }

    private var pinnedOptionsMenu: some View {
        Menu {
            Button("All pinned tasks", systemImage: "pin") { store.selectSection("pins") }
                .accessibilityIdentifier("navigation-pins")
        } label: {
            Image(systemName: "ellipsis")
                .font(NativePreferences.shared.font(size: 13, surface: "sidebar"))
                .frame(width: 22, height: 22)
                .contentShape(.rect)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Pinned task options")
        .accessibilityLabel("Pinned task options")
    }

    private var projectOptionsMenu: some View {
        Menu {
            Button("Open project…", systemImage: "folder.badge.plus", action: openProject)
                .disabled(!store.isConnected)
                .accessibilityIdentifier("open-project")
            Button("Project library…", systemImage: "books.vertical") { showingLibrary = true }
                .disabled(!store.isSelectedHostConnected)
            if !hiddenIDs.isEmpty {
                Divider()
                Toggle("Show hidden projects (\(hiddenIDs.count))", isOn: $showHidden)
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(NativePreferences.shared.font(size: 13, surface: "sidebar"))
                .frame(width: 22, height: 22)
                .contentShape(.rect)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Project options")
        .accessibilityLabel("Project options")
        .accessibilityIdentifier("project-options")
    }

    private var extensionPanels: [NativeSidebarExtensionPanel] {
        NativeSidebarExtensions(store.extensions).panels
    }

    private var activeOptionTitle: String? {
        if let destination = ProjectNavigatorDestination.secondary.first(where: { $0.id == store.selectedSection }) {
            return destination.title
        }
        if store.selectedSection == "settings" { return "Settings" }
        if store.selectedSection == "extension-panel" {
            return extensionPanels.first {
                $0.extensionID == store.selectedExtensionID && $0.panelID == store.selectedPanelID
            }?.title
        }
        return nil
    }

    private var activeOptionSymbol: String {
        if let destination = ProjectNavigatorDestination.secondary.first(where: { $0.id == store.selectedSection }) {
            return destination.symbol
        }
        if store.selectedSection == "settings" { return "gearshape" }
        if store.selectedSection == "extension-panel" {
            return extensionPanels.first {
                $0.extensionID == store.selectedExtensionID && $0.panelID == store.selectedPanelID
            }?.symbol ?? "slider.horizontal.3"
        }
        return "slider.horizontal.3"
    }

    private var optionsFooter: some View {
        NativeSidebarFooter {
            Menu {
                ForEach(ProjectNavigatorDestination.secondary) { destination in
                    Button(destination.title, systemImage: store.selectedSection == destination.id ? "checkmark" : destination.symbol) {
                        store.selectSection(destination.id)
                    }
                    .accessibilityIdentifier("navigation-\(destination.id)")
                }
                if !extensionPanels.isEmpty {
                    Divider()
                    ForEach(extensionPanels) { panel in
                        Button(panel.title, systemImage: store.selectedSection == "extension-panel" && store.selectedExtensionID == panel.extensionID && store.selectedPanelID == panel.panelID ? "checkmark" : panel.symbol) {
                            store.selectExtensionPanel(extensionID: panel.extensionID, panelID: panel.panelID)
                        }
                    }
                }
                Divider()
                Button("Keyboard shortcuts…", systemImage: "keyboard") {
                    store.selectSection("settings")
                    NotificationCenter.default.post(name: .init("falcondeck.native.openSettingsSection"), object: "keyboard")
                }
                Button("Settings…", systemImage: store.selectedSection == "settings" ? "checkmark" : "gearshape") {
                    store.selectSection("settings")
                }
                Divider()
                Text("Local daemon: \(store.connectionStatus)")
                Button("Reconnect", systemImage: "arrow.clockwise") { Task { await store.reconnect() } }
            } label: {
                // Naming the open destination keeps the footer from reading as
                // "Options" while Activity, Usage or Settings fills the window.
                Label(activeOptionTitle ?? "Options", systemImage: activeOptionSymbol)
                    .lineLimit(1)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.visible)
            .controlSize(.regular)
            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
            .contentShape(.rect)
            .background(activeOptionTitle == nil ? Color.clear : FDTheme.hover, in: .rect(cornerRadius: 6))
            .help("Options")
            .accessibilityLabel(activeOptionTitle.map { "Options, \($0) selected" } ?? "Options")
            .accessibilityIdentifier("navigation-options")

            Circle().fill(store.isConnected ? FDTheme.accent : FDTheme.warning)
                .frame(width: 6, height: 6)
                .padding(.trailing, 8)
                .help("Local daemon: \(store.connectionStatus)")
                .accessibilityLabel("Local daemon: \(store.connectionStatus)")
        }
    }

    private func iconWebsiteSheet(_ project: Project) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Website icon").font(NativePreferences.shared.font(size: 18, surface: "sidebar", weight: .semibold))
            Text("Use a website’s icon for \(project.name).")
                .font(NativePreferences.shared.font(size: 13, surface: "sidebar")).foregroundStyle(FDTheme.muted)
            TextField("example.com", text: $iconDomain)
                .textFieldStyle(.roundedBorder)
                .onSubmit { submitIconWebsite(project) }
            if let iconError {
                Text(iconError).font(NativePreferences.shared.font(size: 13, surface: "sidebar")).foregroundStyle(FDTheme.danger)
            }
            HStack {
                Spacer()
                Button("Cancel") { iconProject = nil }.keyboardShortcut(.cancelAction)
                Button(isSavingIcon ? "Saving…" : "Save") { submitIconWebsite(project) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isSavingIcon || iconDomain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 390)
        .interactiveDismissDisabled(isSavingIcon)
    }

    private func submitIconWebsite(_ project: Project) {
        guard !isSavingIcon else { return }
        let input = iconDomain.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: input.contains("://") ? input : "https://\(input)"),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host?.lowercased(), host.contains("."), !host.contains(" ") else {
            iconError = "Enter a website like example.com."
            return
        }
        isSavingIcon = true
        iconError = nil
        Task {
            do {
                let value = mapPreference("workspace_icons", id: project.id,
                                          value: .object(["mode": .string("domain"), "domain": .string(host)]))
                try await store.updateNavigationPreferences(.object(["workspace_icons": value]), hostID: NativeHostManager.split(project.id).hostID)
                iconProject = nil
            } catch { iconError = error.localizedDescription }
            isSavingIcon = false
        }
    }

    private func openProject() {
        let panel = NSOpenPanel()
        panel.title = "Open project"
        panel.prompt = "Open project"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in await store.openProject(path: url.path) }
        }
    }

    private func closeProject(_ project: Project) {
        let active = store.tasks.contains { $0.projectID == project.id && ($0.running || $0.awaitingInput) }
        if active && !confirm(title: "Remove \(project.name) from the sidebar?",
                              detail: "This project has active work. Removing it stops that work until you add the project back. You can reopen it from the project library.",
                              action: "Remove from Sidebar") { return }
        mutateProject(project.id, method: "POST", suffix: "/close")
    }

    private func forgetProject(_ project: Project) {
        var detail = "FalconDeck will forget this project. Tasks stay in the agent’s own history; add the folder again to restore them."
        if store.tasks.contains(where: { $0.projectID == project.id && $0.raw["variant"] != .null }) {
            detail += " Isolated worktrees associated with this project will be removed."
        }
        guard confirm(title: "Forget \(project.name)?", detail: detail, action: "Forget") else { return }
        mutateProject(project.id, method: "DELETE")
    }

    private func confirm(title: String, detail: String, action: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: action)
        return alert.runModal() == .alertSecondButtonReturn
    }

    private func mutateProject(_ id: String, method: String, suffix: String = "") {
        busyProjects.insert(id)
        Task {
            defer { busyProjects.remove(id) }
            do {
                _ = try await store.request(path: "/api/workspaces/\(projectPathSegment(id))\(suffix)", method: method)
                await store.refresh()
            } catch { store.errorMessage = error.localizedDescription }
        }
    }

    private func refreshPinOrder() {
        pinnedOrder = ordering.ordered(pinCandidates, mode: sort, scope: "global-pins")
    }

    private func moveProjectBy(_ id: String, offset: Int) {
        var ids = orderedProjects.map(\.id)
        guard let index = ids.firstIndex(of: id), ids.indices.contains(index + offset) else { return }
        ids.swapAt(index, index + offset)
        saveProjectOrder(ids)
    }

    private func moveProject(_ id: String, before target: String?) {
        guard id != target, orderedProjects.contains(where: { $0.id == id }) else { return }
        var ids = orderedProjects.map(\.id).filter { $0 != id }
        if let target, let index = ids.firstIndex(of: target) { ids.insert(id, at: index) }
        else { ids.append(id) }
        saveProjectOrder(ids)
    }

    private func projectColor(_ id: String) -> Color {
        let token = store.navigationPreferences["workspace_colors"][id].string
        return token.isEmpty ? FDTheme.muted : FDTheme.categoryColor(token)
    }

    private func saveIcon(_ id: String, value: JSON?) {
        saveMapPreference("workspace_icons", id: id, value: value)
    }

    private func mapPreference(_ key: String, id: String, value: JSON?) -> JSON {
        var fields: [String: JSON] = [:]
        if case .object(let current) = store.navigationPreferences[key] { fields = current }
        fields[id] = value
        return .object(fields)
    }

    private func saveMapPreference(_ key: String, id: String, value: JSON?) {
        savePreferences(.object([key: mapPreference(key, id: id, value: value)]), hostID: NativeHostManager.split(id).hostID)
    }

    private func saveProjectOrder(_ ids: [String]) {
        let hosts = Set(ids.compactMap { NativeHostManager.split($0).hostID })
        Task {
            do {
                let patch: JSON = .object(["workspace_order": .array(ids.map(JSON.string))])
                try await store.updateNavigationPreferences(patch, hostID: nil)
                for host in hosts.sorted() { try await store.updateNavigationPreferences(patch, hostID: host) }
            } catch { store.errorMessage = error.localizedDescription }
        }
    }

    private func savePreferences(_ patch: JSON, hostID: String? = nil) {
        Task {
            do { try await store.updateNavigationPreferences(patch, hostID: hostID) }
            catch { store.errorMessage = error.localizedDescription }
        }
    }
}

private struct ProjectNavigatorDestination: Identifiable {
    let id: String
    let title: String
    let symbol: String

    static let secondary: [Self] = [
        .init(id: "automations", title: "Automations", symbol: "clock.arrow.circlepath"),
        .init(id: "usage", title: "Usage", symbol: "chart.bar"),
        .init(id: "plugins", title: "Plugins", symbol: "puzzlepiece.extension"),
        .init(id: "extensions", title: "Extensions", symbol: "square.stack.3d.up")
    ]
}

struct ProjectNavigatorGlyph: View {
    let store: AppStore
    let project: Project
    let preference: JSON
    let color: Color
    @State private var image: NSImage?

    private var loadKey: ProjectIconLoadKey {
        ProjectIconLoadKey(projectID: project.id, preference: preference,
                           resolved: project.raw["icon"], connected: isConnected)
    }

    private var isConnected: Bool {
        guard let hostID = NativeHostManager.split(project.id).hostID else { return store.isConnected }
        return NativeHostManager.shared.hosts.first { $0.id == hostID }?.status == .connected
    }

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().interpolation(.high).scaledToFit()
            } else {
                Image(systemName: preference["mode"].string == "domain" ? "globe" : "folder.fill")
                    .font(NativePreferences.shared.font(size: 14, surface: "sidebar")).foregroundStyle(color)
            }
        }
        .frame(width: 18, height: 18)
        .accessibilityHidden(true)
        .task(id: loadKey) { await loadImage() }
    }

    private func loadImage() async {
        image = nil
        guard isConnected, preference["mode"].string != "folder",
              project.raw["icon"]["kind"].string == "image" || preference["mode"].string == "domain" else { return }
        do {
            if NativeHostManager.split(project.id).hostID != nil {
                let result = try await store.request(["api", "workspace-icons", project.id])
                try Task.checkCancellation()
                guard result["kind"].string == "image",
                      result["content_type"].string.lowercased().hasPrefix("image/"),
                      result["data"].string.utf8.count <= 2_796_204,
                      let bytes = Data(base64Encoded: result["data"].string),
                      !bytes.isEmpty, bytes.count <= 2_097_152,
                      let decoded = NSImage(data: bytes), decoded.isValid else { return }
                image = decoded
                return
            }
            let endpoint = try await store.daemonEndpoint()
            try Task.checkCancellation()
            let url = DaemonClient.apiURL(base: endpoint, path: ["api", "workspace-icons", project.id], query: [
                URLQueryItem(name: "v", value: project.raw["icon"]["etag"].string),
                URLQueryItem(name: "domain", value: preference["domain"].string)
            ])
            var request = URLRequest(url: url)
            request.timeoutInterval = 12
            request.setValue("image/*", forHTTPHeaderField: "Accept")
            let (bytes, response) = try await URLSession.shared.data(for: request)
            try Task.checkCancellation()
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.mimeType?.lowercased().hasPrefix("image/") == true,
                  !bytes.isEmpty, bytes.count <= 2_097_152,
                  let decoded = NSImage(data: bytes), decoded.isValid else { return }
            image = decoded
        } catch {
            // Missing or unsupported project icons retain the native fallback;
            // cancelling the row's task must never publish an obsolete image.
        }
    }
}

private struct ProjectIconLoadKey: Equatable {
    let projectID: String
    let preference: JSON
    let resolved: JSON
    let connected: Bool
}

private struct ProjectLibrarySheet: View {
    @Bindable var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [Project] = []
    @State private var search = ""
    @State private var loading = true
    @State private var openingID: String?
    @State private var error: String?
    @State private var hostID: String?

    private var matching: [Project] {
        entries.filter { search.isEmpty || $0.path.localizedCaseInsensitiveContains(search) }
    }

    private var hostConnected: Bool {
        guard let hostID else { return store.isConnected }
        return NativeHostManager.shared.hosts.first { $0.id == hostID }?.status == .connected
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "books.vertical").foregroundStyle(FDTheme.muted)
                Text("Project library").font(NativePreferences.shared.font(size: 18, surface: "sidebar", weight: .semibold))
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(20)
            Divider()
            TextField("Search closed projects", text: $search)
                .textFieldStyle(.roundedBorder).padding(16)
            if let error {
                HStack {
                    Text(error).foregroundStyle(FDTheme.danger).font(NativePreferences.shared.font(size: 13, surface: "sidebar"))
                    Spacer()
                    Button("Retry") { Task { await load() } }
                }
                .padding(.horizontal, 16).padding(.bottom, 12)
            }
            if loading {
                VStack(spacing: 10) {
                    MacActivityDiamond()
                    Text("Loading projects…").foregroundStyle(FDTheme.muted).font(NativePreferences.shared.font(size: 13, surface: "sidebar"))
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if matching.isEmpty {
                NativeEmptyState(symbol: "books.vertical", title: entries.isEmpty ? "No closed projects" : "No matching projects",
                                 detail: entries.isEmpty ? "Projects removed from the sidebar remain here, ready to reopen." : "Try another project name or path.")
            } else {
                List(matching) { project in
                    HStack(spacing: 12) {
                        Image(systemName: "folder").foregroundStyle(FDTheme.muted)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(project.name).font(NativePreferences.shared.font(size: 13, surface: "sidebar", weight: .medium))
                            Text(project.path).font(NativePreferences.shared.font(size: 11, surface: "sidebar")).foregroundStyle(FDTheme.muted).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer()
                        Button(openingID == project.id ? "Opening…" : "Open") { open(project) }
                            .disabled(openingID != nil || !hostConnected)
                    }
                    .padding(.vertical, 6)
                    .help(project.path)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        }
        .frame(width: 620, height: 450)
        .background(FDTheme.surface)
        .task { hostID = store.selectedHostID; await load() }
    }

    private func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let snapshot = try await store.request(["api", "snapshot"], hostID: hostID)
            let active = Set(store.allProjects.map(\.id))
            entries = snapshot["library_workspaces"].array.filter {
                $0["kind"].string != "casual" && !active.contains($0["id"].string)
            }.sorted { $0["last_opened_at"].string > $1["last_opened_at"].string }.map(Project.init)
        } catch { self.error = error.localizedDescription }
    }

    private func open(_ project: Project) {
        openingID = project.id
        error = nil
        Task {
            defer { openingID = nil }
            do {
                let connected = try await store.request(["api", "workspaces", "connect"], method: "POST", body: .object(["path": .string(project.path)]), hostID: hostID)
                await store.refresh()
                store.selectProject(connected["id"].string)
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}

/// Mirrors the shared Falcon dark categorical tokens, while persisting their
/// stable ids rather than a platform-specific color value.
@MainActor private struct ProjectCategoryColor: Identifiable {
    let id: String
    let name: String
    var color: Color { FDTheme.categoryColor(id) }
    static let all: [Self] = [
        .init(id: "cat-1", name: "Red"), .init(id: "cat-2", name: "Orange"),
        .init(id: "cat-3", name: "Amber"), .init(id: "cat-4", name: "Lime"),
        .init(id: "cat-5", name: "Green"), .init(id: "cat-6", name: "Teal"),
        .init(id: "cat-7", name: "Cyan"), .init(id: "cat-8", name: "Blue"),
        .init(id: "cat-9", name: "Indigo"), .init(id: "cat-10", name: "Violet"),
        .init(id: "cat-11", name: "Fuchsia"), .init(id: "cat-12", name: "Pink")
    ]
}

private func projectPathSegment(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
}
