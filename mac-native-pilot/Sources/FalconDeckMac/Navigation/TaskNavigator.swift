import AppKit
import SwiftUI

struct NativeProjectFolder: Identifiable {
    let raw: JSON
    var id: String { raw["id"].string }
    var name: String { raw["name"].string }
    var collapsed: Bool { raw["collapsed"].bool }
    var taskIDs: Set<String> { Set(raw["thread_ids"].array.map(\.string)) }
}

/// Keep the accessibility tree bounded while retaining a navigated selection.
struct NativeTaskNavigationPage {
    static let initialLimit = 80
    static let increment = 100
    let orderedIDs: [String]
    let limit: Int
    let selectedID: String?

    let includedIDs: Set<String>

    init(orderedIDs: [String], limit: Int, selectedID: String?) {
        self.orderedIDs = orderedIDs
        self.limit = limit
        self.selectedID = selectedID
        var included = Set(orderedIDs.prefix(max(limit, 0)))
        if let selectedID, orderedIDs.contains(selectedID) { included.insert(selectedID) }
        includedIDs = included
    }
    var remainingCount: Int { max(orderedIDs.count - includedIDs.count, 0) }
    var nextLimit: Int { min(orderedIDs.count, max(limit, 0) + Self.increment) }
}

struct TaskNavigator: View {
    @Bindable var store: AppStore
    @AppStorage("native.tasks.sort") private var sort = "last_updated"
    @AppStorage("native.tasks.filter") private var filter = "all"
    @AppStorage("native.tasks.archived") private var archived = false
    @State private var orderedIDs: [String] = []
    @State private var ordering = NativeTaskNavigationOrder()
    @State private var renaming: AgentTask?
    @State private var dropTarget: String?
    @State private var extensionState = NativeSidebarExtensions(.null)
    @State private var hostExtensionStates: [String: NativeSidebarExtensions] = [:]
    @State private var extensionSelections: [String: Set<String>] = [:]
    @State private var pageLimit = NativeTaskNavigationPage.initialLimit
    @State private var revealedFolderID: String?

    private var isProject: Bool { store.selectedSection == "project" }
    private var projectID: String? { isProject ? store.selectedProjectID : nil }
    private var title: String {
        switch store.selectedSection {
        case "chats": "Chats"
        case "pins": "Pinned tasks"
        default: store.selectedProject?.name ?? "Tasks"
        }
    }
    private var folders: [NativeProjectFolder] {
        guard let projectID else { return [] }
        return store.navigationPreferences["project_folders"].array
            .filter { $0["workspace_id"].string == projectID }.map(NativeProjectFolder.init)
    }
    private var scopeTasks: [AgentTask] {
        switch store.selectedSection {
        case "pins": return store.tasks.filter(\.pinned)
        case "chats":
            let casual = Set(store.allProjects.filter { $0.raw["kind"].string == "casual" }.map(\.id))
            return store.tasks.filter { casual.contains($0.projectID) }
        default:
            let projectID = store.selectedProjectID
            return store.tasks.filter { $0.projectID == projectID }
        }
    }
    private func extensionSources(for tasks: [AgentTask]) -> [String: JSON] {
        let hosts = Set(tasks.map { NativeHostManager.split($0.id).hostID ?? "local" })
        return Dictionary(uniqueKeysWithValues: hosts.map { host in
            (host, store.extensionsForHost(host == "local" ? nil : host))
        })
    }

    private func navigationContent(for tasks: [AgentTask]) -> NativeTaskNavigationContent {
        let ids = Set(orderedIDs)
        let byID = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { _, rhs in rhs })
        let visible = (orderedIDs.compactMap { byID[$0] } + tasks.filter { !ids.contains($0.id) }).filter(matches)
        let folders = folders
        return NativeTaskNavigationContent(tasks: visible, folders: folders,
            expandedFolderIDs: Set(folders.filter(isFolderExpanded).map(\.id)),
            grouped: isProject && !archived, limit: pageLimit, selectedID: store.selectedTaskID)
    }
    private var pageScope: String {
        [store.selectedSection, projectID ?? "", store.searchText, sort, filter, String(archived)].joined(separator: "|")
    }
    private var selection: Binding<String?> {
        Binding(get: { store.selectedTaskID }, set: { id in
            guard let id else { return }
            Task { await store.selectTask(id) }
        })
    }

    var body: some View {
        let tasks = scopeTasks
        let content = navigationContent(for: tasks)
        let sources = extensionSources(for: tasks)
        // Streaming redraws rows; only structural changes refresh their order.
        let orderKey = tasks.map(NativeTaskNavigationOrder.key)
        return VStack(spacing: 0) {
            header(taskCount: content.count, tasks: tasks)
            FDTheme.hairline.frame(height: 1)
            if content.count == 0 && content.folders.isEmpty {
                NativeEmptyState(
                    symbol: archived ? "archivebox" : "text.bubble",
                    title: archived ? "No archived tasks" : "No tasks here",
                    detail: store.searchText.isEmpty ? "Create a task, or change your filters to see more." : "Try another name or use ⌘K to search message content."
                )
            } else {
                ScrollViewReader { proxy in
                    List(selection: selection) {
                        if isProject && !archived {
                            projectTaskGroups(content)
                        } else {
                            ForEach(content.root) { task in taskRow(task) }
                        }
                        if content.page.remainingCount > 0 { showMoreTasks(content.page) }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .onAppear { scrollToSelection(proxy, page: content.page) }
                    .onChange(of: store.selectedTaskID) { _, _ in scrollToSelection(proxy, page: content.page) }
                    .onChange(of: pageScope) { _, _ in scrollToSelection(proxy, page: content.page) }
                    .onChange(of: revealedFolderID) { _, _ in scrollToSelection(proxy, page: content.page) }
                }
            }
            footer
        }
        .background(FDTheme.surface)
        .onAppear { refreshExtensions(); revealSelection(); refreshOrder() }
        .onChange(of: pageScope) { _, _ in pageLimit = NativeTaskNavigationPage.initialLimit; refreshOrder() }
        .onChange(of: orderKey) { _, _ in refreshOrder() }
        .onChange(of: content.orderedIDs) { _, ids in registerNavigation(ids) }
        .onChange(of: store.extensions) { _, snapshot in
            extensionState = NativeSidebarExtensions(snapshot)
            refreshOrder()
        }
        .onChange(of: sources) { _, _ in refreshExtensions(); refreshOrder() }
        .onChange(of: extensionSelections) { _, _ in pageLimit = NativeTaskNavigationPage.initialLimit; refreshOrder() }
        .onChange(of: store.selectedTaskID) { _, id in
            if id == nil { archived = false; revealedFolderID = nil }
            else { revealSelection() }
        }
        .sheet(item: $renaming) { task in
            NativeTaskRenameSheet(store: store, task: task, dismiss: { renaming = nil })
        }
    }

    private func header(taskCount: Int, tasks: [AgentTask]) -> some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(NativePreferences.shared.font(size: 15, surface: "sidebar", weight: .semibold)).lineLimit(1)
                    if archived { Text("Archived tasks").font(NativePreferences.shared.font(size: 12, surface: "sidebar")).foregroundStyle(FDTheme.muted) }
                }
                Spacer(minLength: 4)
                Text("\(taskCount)").font(NativePreferences.shared.font(size: 11, surface: "sidebar").monospaced()).foregroundStyle(FDTheme.subtle)
                Menu {
                    Picker("Sort tasks", selection: $sort) {
                        Text("Last updated").tag("last_updated")
                        Text("Alphabetical").tag("alphabetical")
                        Text("Needs attention first").tag("priority")
                    }
                    Divider()
                    Picker("Show", selection: $filter) {
                        Text("All tasks").tag("all")
                        Text("Unread").tag("unread")
                        Text("Working").tag("working")
                        Text("Needs attention").tag("attention")
                    }
                    Divider()
                    Toggle("Archived tasks", isOn: $archived)
                    if isProject, let projectID {
                        Divider()
                        Button("New folder…", systemImage: "folder.badge.plus") { createFolder(projectID) }
                        Button("Mark all as read", systemImage: "envelope.open") {
                            NativeTaskActions.perform(store) {
                                for task in tasks where task.unread { try await NativeTaskActions.markRead(task, store: store) }
                            }
                        }
                        Button("Archive all tasks…", systemImage: "archivebox") { archiveAll(projectID) }
                    }
                } label: { Image(systemName: "line.3.horizontal.decrease") }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .help("Sort and filter tasks")
                .accessibilityLabel("Sort and filter tasks")
            }
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").foregroundStyle(FDTheme.subtle)
                TextField("Filter task names", text: $store.searchText)
                    .textFieldStyle(.plain).font(NativePreferences.shared.font(size: 13, surface: "sidebar"))
                    .accessibilityIdentifier("task-search")
                if !store.searchText.isEmpty {
                    Button { store.searchText = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).accessibilityLabel("Clear filter")
                }
            }
            .font(NativePreferences.shared.font(size: 11, surface: "sidebar"))
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(FDTheme.raised, in: .rect(cornerRadius: 7))
            .overlay { RoundedRectangle(cornerRadius: 7).strokeBorder(FDTheme.hairline) }
            if filter != "all" {
                HStack {
                    Text(filterLabel).font(NativePreferences.shared.font(size: 12, surface: "sidebar")).foregroundStyle(FDTheme.muted)
                    Spacer()
                    Button("Clear") { filter = "all" }.buttonStyle(.plain).font(NativePreferences.shared.font(size: 12, surface: "sidebar"))
                }
            }
            if !extensionState.filters.isEmpty {
                HStack(spacing: 8) {
                    ForEach(extensionState.filters) { extensionFilter in
                        extensionFilterMenu(extensionFilter)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(16)
        .contentShape(.rect)
        .dropDestination(for: String.self) { ids, _ in return drop(ids, folder: nil) }
    }

    @ViewBuilder private func projectTaskGroups(_ content: NativeTaskNavigationContent) -> some View {
        if content.pinnedCount > 0 {
            Section {
                ForEach(content.pinned) { task in taskRow(task) }
            } header: {
                Label("Pinned in project", systemImage: "pin").font(NativePreferences.shared.font(size: 12, surface: "sidebar", weight: .medium))
            }
        }
        ForEach(content.folders) { group in
            Section {
                if isFolderExpanded(group.folder) {
                    ForEach(group.tasks) { task in taskRow(task) }
                    if group.count == 0 {
                        Text("Drop tasks here").font(NativePreferences.shared.font(size: 11, surface: "sidebar")).foregroundStyle(FDTheme.subtle)
                            .padding(.leading, 18).padding(.vertical, 5)
                    }
                }
            } header: {
                folderHeader(group.folder, count: group.count)
            }
        }
        Section {
            ForEach(content.root) { task in taskRow(task) }
        } header: {
            if !content.folders.isEmpty || content.pinnedCount > 0 {
                Text("Tasks").font(NativePreferences.shared.font(size: 12, surface: "sidebar", weight: .medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                    .dropDestination(for: String.self) { ids, _ in return drop(ids, folder: nil) }
            }
        }
    }

    private func folderHeader(_ folder: NativeProjectFolder, count: Int) -> some View {
        Button {
            guard let projectID else { return }
            let collapse = isFolderExpanded(folder)
            if revealedFolderID == folder.id { revealedFolderID = nil }
            NativeTaskActions.perform(store) {
                try await NativeTaskActions.folderMutation(store: store, projectID: projectID, fields: [
                    "action": .string("set_collapsed"), "folder_id": .string(folder.id), "collapsed": .bool(collapse)
                ])
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: isFolderExpanded(folder) ? "chevron.down" : "chevron.right").font(NativePreferences.shared.font(size: 8, surface: "sidebar", weight: .semibold)).frame(width: 9)
                Image(systemName: "folder").font(NativePreferences.shared.font(size: 11, surface: "sidebar"))
                Text(folder.name).lineLimit(1)
                Spacer(minLength: 2)
                Text("\(count)").foregroundStyle(FDTheme.subtle).monospacedDigit()
            }
            .font(NativePreferences.shared.font(size: 12, surface: "sidebar", weight: .medium))
            .padding(.vertical, 6).contentShape(.rect)
            .background(dropTarget == folder.id ? FDTheme.accentMuted : Color.clear, in: .rect(cornerRadius: 5))
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Rename folder…", systemImage: "pencil") { renameFolder(folder) }
            Button("New task in folder", systemImage: "plus") { newTask(folder: folder.id) }
            Divider()
            Button("Delete folder…", systemImage: "trash", role: .destructive) { deleteFolder(folder) }
        }
        .dropDestination(for: String.self) { ids, _ in drop(ids, folder: folder.id) } isTargeted: { targeted in
            dropTarget = targeted ? folder.id : nil
        }
    }

    private func taskRow(_ task: AgentTask) -> some View {
        TaskNavigationRow(task: task, project: store.selectedSection == "pins" ? store.allProjects.first { $0.id == task.projectID } : nil, stage: extensions(for: task).stage(task))
            .tag(task.id)
            .id(task.id)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 3, leading: 10, bottom: 3, trailing: 10))
            .contextMenu { NativeTaskContextMenu(store: store, task: task, rename: { renaming = task }) }
            .draggable("falcondeck-task:\(task.projectID):\(task.id)")
            .accessibilityIdentifier("task-\(task.id)")
    }

    private func showMoreTasks(_ page: NativeTaskNavigationPage) -> some View {
        Button {
            pageLimit = page.nextLimit
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "chevron.down")
                Text("Show \(min(page.remainingCount, NativeTaskNavigationPage.increment)) more tasks")
                Spacer()
                Text("\(page.remainingCount) remaining").foregroundStyle(FDTheme.muted)
            }
            .font(NativePreferences.shared.font(size: 12, surface: "sidebar"))
            .foregroundStyle(FDTheme.accent)
            .padding(.vertical, 10)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
        .accessibilityIdentifier("show-more-tasks")
    }

    private func isFolderExpanded(_ folder: NativeProjectFolder) -> Bool {
        !folder.collapsed || folder.id == revealedFolderID || !store.searchText.isEmpty
    }

    private func revealSelection() {
        guard let id = store.selectedTaskID, let task = store.tasks.first(where: { $0.id == id }) else { return }
        archived = task.raw["is_archived"].bool
        // Navigation should reveal its destination even when a prior filter hid it.
        if !matches(task) {
            store.searchText = ""; filter = "all"; extensionSelections = [:]
        }
        revealedFolderID = folders.first { $0.taskIDs.contains(id) && $0.collapsed }?.id
    }

    private func scrollToSelection(_ proxy: ScrollViewProxy, page: NativeTaskNavigationPage) {
        guard let id = store.selectedTaskID, page.includedIDs.contains(id) else { return }
        Task { @MainActor in
            await Task.yield()
            guard store.selectedTaskID == id else { return }
            proxy.scrollTo(id, anchor: .center)
        }
    }

    private var footer: some View {
        NativeSidebarFooter {
            if archived {
                Button { archived = false } label: { Label("Back to active tasks", systemImage: "arrow.uturn.backward") }
                    .buttonStyle(.plain)
            } else {
                Button { newTask() } label: {
                    Label(store.selectedSection == "chats" ? "New chat" : "New task", systemImage: "plus")
                }
                .buttonStyle(.plain)
                .disabled(!store.isSelectedHostConnected)
            }
            Spacer()
            if isProject, let projectID {
                Button { createFolder(projectID) } label: { Image(systemName: "folder.badge.plus") }
                    .buttonStyle(NativeIconButtonStyle()).help("New folder").accessibilityLabel("New folder")
            }
        }
    }

    private var filterLabel: String {
        switch filter {
        case "unread": "Unread tasks"
        case "working": "Working tasks"
        case "attention": "Tasks needing attention"
        default: "All tasks"
        }
    }

    private func matches(_ task: AgentTask) -> Bool {
        guard task.raw["is_archived"].bool == archived else { return false }
        if filter == "unread" && !task.unread { return false }
        if filter == "working" && !task.running { return false }
        if filter == "attention" && !task.needsAttention { return false }
        guard extensions(for: task).matches(taskID: task.id, selections: extensionSelections) else { return false }
        return store.searchText.isEmpty || task.title.localizedCaseInsensitiveContains(store.searchText) || task.preview.localizedCaseInsensitiveContains(store.searchText)
    }

    private func extensionFilterMenu(_ definition: NativeSidebarExtensionFilter) -> some View {
        Menu {
            if definition.supported {
                Button("All tasks") { extensionSelections[definition.id] = [] }
                Divider()
                ForEach(definition.options, id: \.self) { option in
                    let value = option["value"].string
                    let selected = extensionSelections[definition.id, default: []].contains(value)
                    Button(option["label"].string, systemImage: selected ? "checkmark.circle.fill" : "circle") {
                        if definition.multiple {
                            if selected { extensionSelections[definition.id, default: []].remove(value) }
                            else { extensionSelections[definition.id, default: []].insert(value) }
                        } else { extensionSelections[definition.id] = selected ? [] : [value] }
                    }
                }
            } else { Text("This extension filter requires a newer app.") }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: definition.supported ? "line.3.horizontal.decrease.circle" : "exclamationmark.triangle")
                Text(definition.title.isEmpty ? "Extension filter" : definition.title)
                let count = extensionSelections[definition.id, default: []].count
                if count > 0 { Text("\(count)").monospacedDigit() }
            }
            .font(NativePreferences.shared.font(size: 11, surface: "sidebar"))
            .foregroundStyle(extensionSelections[definition.id, default: []].isEmpty ? FDTheme.muted : FDTheme.accent)
        }
        .menuStyle(.borderlessButton).fixedSize()
    }

    private func extensions(for task: AgentTask) -> NativeSidebarExtensions {
        hostExtensionStates[NativeHostManager.split(task.id).hostID ?? "local"] ?? extensionState
    }

    private func refreshExtensions() {
        extensionState = NativeSidebarExtensions(store.extensions)
        hostExtensionStates = extensionSources(for: scopeTasks).mapValues(NativeSidebarExtensions.init)
    }

    private func refreshOrder() {
        let tasks = scopeTasks
        orderedIDs = ordering.ordered(tasks.filter(matches), mode: sort, scope: "\(store.selectedSection):\(projectID ?? "")")
        registerNavigation(navigationContent(for: tasks).orderedIDs)
    }

    private func registerNavigation(_ ids: [String]) {
        guard ["project", "chats", "pins"].contains(store.selectedSection) else { return }
        store.registerTaskNavigation(ids, section: store.selectedSection, projectID: projectID)
    }

    private func newTask(folder: String? = nil) {
        archived = false
        if store.selectedSection == "chats" || store.selectedProject == nil {
            Task { await store.newChat() }
        } else if let folder, let projectID {
            let navigation = store.navigationID
            NativeTaskActions.perform(store) {
                let handle = try await store.request(path: "/api/workspaces/\(projectID)/threads", method: "POST", body: .object([
                    "workspace_id": .string(projectID), "provider": .string(store.provider)
                ]))
                let task = AgentTask(handle["thread"])
                try await NativeTaskActions.move(task, to: folder, store: store)
                await store.refresh()
                await store.openCreatedTask(task.id, after: navigation)
            }
        } else {
            store.selectSection(store.selectedProject?.raw["kind"].string == "casual" ? "chats" : "project")
            store.newTask(focusComposer: true)
        }
    }

    private func createFolder(_ projectID: String) {
        guard let name = NativeNavigationDialogs.name(title: "New folder", detail: "Folders organize tasks without changing their working directories.", action: "Create folder") else { return }
        NativeTaskActions.perform(store) {
            try await NativeTaskActions.folderMutation(store: store, projectID: projectID, fields: ["action": .string("create"), "name": .string(name)])
        }
    }

    private func renameFolder(_ folder: NativeProjectFolder) {
        guard let projectID, let name = NativeNavigationDialogs.name(title: "Rename folder", initial: folder.name) else { return }
        NativeTaskActions.perform(store) {
            try await NativeTaskActions.folderMutation(store: store, projectID: projectID, fields: [
                "action": .string("rename"), "folder_id": .string(folder.id), "name": .string(name)
            ])
        }
    }

    private func deleteFolder(_ folder: NativeProjectFolder) {
        guard let projectID, NativeNavigationDialogs.confirm(title: "Delete “\(folder.name)” ?", detail: "Its tasks will return to the project root.", action: "Delete folder", destructive: true) else { return }
        NativeTaskActions.perform(store) {
            try await NativeTaskActions.folderMutation(store: store, projectID: projectID, fields: ["action": .string("delete"), "folder_id": .string(folder.id)])
        }
    }

    private func archiveAll(_ projectID: String) {
        guard NativeNavigationDialogs.confirm(title: "Archive all tasks in \(title)?", detail: "You can restore tasks from Archived tasks. Working tasks, tasks waiting for input and queued turns remain active.", action: "Archive all", destructive: true) else { return }
        NativeTaskActions.perform(store) {
            _ = try await store.request(path: "/api/workspaces/\(projectID)/threads/archive", method: "POST")
            await store.refresh()
        }
    }

    private func drop(_ identifiers: [String], folder: String?) -> Bool {
        guard let projectID else { return false }
        let prefix = "falcondeck-task:\(projectID):"
        let ids = identifiers.filter { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)) }
        guard !ids.isEmpty else { return false }
        NativeTaskActions.perform(store) {
            for id in ids {
                guard let task = store.tasks.first(where: { $0.id == id && $0.projectID == projectID }) else { continue }
                try await NativeTaskActions.move(task, to: folder, store: store)
            }
        }
        return true
    }
}

struct TaskNavigationRow: View {
    let task: AgentTask
    var project: Project?
    var stage: JSON?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if task.unread { Circle().fill(FDTheme.info).frame(width: 5, height: 5).accessibilityLabel("Unread") }
                Text(task.title).font(NativePreferences.shared.font(size: 13, surface: "sidebar", weight: task.unread ? .medium : .regular))
                    .foregroundStyle(FDTheme.foreground).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                TaskStatusMark(status: task.status)
            }
            let preview = task.previewLine
            if !preview.isEmpty {
                Text(preview)
                    .font(NativePreferences.shared.font(size: 12, surface: "sidebar")).foregroundStyle(FDTheme.muted).lineLimit(1)
            }
            HStack(spacing: 5) {
                if let stage {
                    Circle().fill(NativeSidebarExtensions.tone(stage["color"].string)).frame(width: 5, height: 5)
                    Text(stage["label"].string).lineLimit(1)
                    Text("·")
                }
                if let project { Text(project.name).lineLimit(1); Text("·") }
                Text(FDTheme.providerName(task.provider))
                if task.running {
                    Text("·"); Text("Working").foregroundStyle(FDTheme.accent)
                } else if task.awaitingInput {
                    Text("·"); Text(FDTheme.statusLabel(task.status)).foregroundStyle(FDTheme.warning)
                }
                Spacer(minLength: 2)
                if let age = NativeDates.shortRelative(iso: task.updatedAt) {
                    Text(age).lineLimit(1).monospacedDigit()
                        .help("Last updated " + NativeDates.absoluteLabel(iso: task.updatedAt))
                        .accessibilityLabel("Updated \(age) ago")
                }
            }
            .font(NativePreferences.shared.font(size: 11, surface: "sidebar")).foregroundStyle(FDTheme.subtle)
        }
        .padding(.horizontal, 7).padding(.vertical, 9).contentShape(.rect)
    }
}
