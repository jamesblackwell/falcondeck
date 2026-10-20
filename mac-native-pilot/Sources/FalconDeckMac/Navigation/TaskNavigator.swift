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

    var includedIDs: Set<String> {
        var result = Set(orderedIDs.prefix(max(limit, 0)))
        if let selectedID, orderedIDs.contains(selectedID) { result.insert(selectedID) }
        return result
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
        let casual = Set(store.allProjects.filter { $0.raw["kind"].string == "casual" }.map(\.id))
        return store.tasks.filter { task in
            switch store.selectedSection {
            case "pins": return task.pinned
            case "chats": return casual.contains(task.projectID) && (task.raw["is_archived"].bool || !task.pinned)
            default: return task.projectID == store.selectedProjectID && (task.raw["is_archived"].bool || !task.pinned)
            }
        }
    }
    private var extensionSources: [String: JSON] {
        let hosts = Set(scopeTasks.map { NativeHostManager.split($0.id).hostID ?? "local" })
        return Dictionary(uniqueKeysWithValues: hosts.map { host in
            (host, store.extensionsForHost(host == "local" ? nil : host))
        })
    }
    private var visibleTasks: [AgentTask] {
        let ids = Set(orderedIDs)
        let byID = Dictionary(scopeTasks.map { ($0.id, $0) }, uniquingKeysWith: { _, rhs in rhs })
        return orderedIDs.compactMap { byID[$0] }.filter(matches) + scopeTasks.filter { !ids.contains($0.id) && matches($0) }
    }
    /// Page in the order rows are displayed, retaining project pin/folder groups.
    private var displayOrderedTasks: [AgentTask] {
        let tasks = visibleTasks
        guard isProject && !archived else { return tasks }
        var result = tasks.filter { $0.raw["is_pinned_in_project"].bool }
        var groupedIDs = Set(result.map(\.id))
        for folder in folders {
            let members = tasks.filter { folder.taskIDs.contains($0.id) && !groupedIDs.contains($0.id) }
            groupedIDs.formUnion(members.map(\.id))
            if isFolderExpanded(folder) { result.append(contentsOf: members) }
        }
        result.append(contentsOf: tasks.filter { !groupedIDs.contains($0.id) })
        return result
    }
    private var page: NativeTaskNavigationPage {
        NativeTaskNavigationPage(orderedIDs: displayOrderedTasks.map(\.id), limit: pageLimit, selectedID: store.selectedTaskID)
    }
    private var pageScope: String {
        [store.selectedSection, projectID ?? "", store.searchText, sort, filter, String(archived)].joined(separator: "|")
    }
    /// Do not sort the whole project each time a streaming preview changes.
    /// Token updates redraw existing rows while structural changes refresh order.
    private var orderKey: String {
        [store.selectedSection, projectID ?? "", store.searchText, sort, filter, String(archived)]
            .joined(separator: "|") + scopeTasks.map {
                "\($0.id):\($0.title):\($0.status):\($0.pinned):\($0.raw["is_pinned_in_project"].bool):\($0.raw["is_archived"].bool):\($0.unread):\($0.running ? "" : $0.updatedAt)"
            }.joined(separator: "|")
    }
    private var selection: Binding<String?> {
        Binding(get: { store.selectedTaskID }, set: { id in
            guard let id else { return }
            Task { await store.selectTask(id) }
        })
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            FDTheme.hairline.frame(height: 1)
            if visibleTasks.isEmpty && folders.isEmpty {
                NativeEmptyState(
                    symbol: archived ? "archivebox" : "text.bubble",
                    title: archived ? "No archived tasks" : "No tasks here",
                    detail: store.searchText.isEmpty ? "Create a task, or change your filters to see more." : "Try another name or use ⌘K to search message content."
                )
            } else {
                ScrollViewReader { proxy in
                    List(selection: selection) {
                        if isProject && !archived {
                            projectTaskGroups
                        } else {
                            let included = page.includedIDs
                            ForEach(visibleTasks.filter { included.contains($0.id) }) { task in taskRow(task) }
                        }
                        if page.remainingCount > 0 { showMoreTasks }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .onAppear { scrollToSelection(proxy) }
                    .onChange(of: store.selectedTaskID) { _, _ in scrollToSelection(proxy) }
                    .onChange(of: pageScope) { _, _ in scrollToSelection(proxy) }
                    .onChange(of: revealedFolderID) { _, _ in scrollToSelection(proxy) }
                }
            }
            footer
        }
        .background(FDTheme.surface)
        .onAppear { refreshExtensions(); revealSelection(); refreshOrder() }
        .onChange(of: pageScope) { _, _ in pageLimit = NativeTaskNavigationPage.initialLimit }
        .onChange(of: orderKey) { _, _ in refreshOrder() }
        .onChange(of: store.extensions) { _, snapshot in
            extensionState = NativeSidebarExtensions(snapshot)
            refreshOrder()
        }
        .onChange(of: extensionSources) { _, _ in refreshExtensions(); refreshOrder() }
        .onChange(of: extensionSelections) { _, _ in pageLimit = NativeTaskNavigationPage.initialLimit; refreshOrder() }
        .onChange(of: store.selectedTaskID) { _, id in
            if id == nil { archived = false; revealedFolderID = nil }
            else { revealSelection() }
        }
        .sheet(item: $renaming) { task in
            NativeTaskRenameSheet(store: store, task: task, dismiss: { renaming = nil })
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(NativePreferences.shared.font(size: 15, surface: "sidebar", weight: .semibold)).lineLimit(1)
                    if archived { Text("Archived tasks").font(NativePreferences.shared.font(size: 12, surface: "sidebar")).foregroundStyle(FDTheme.muted) }
                }
                Spacer(minLength: 4)
                Text("\(visibleTasks.count)").font(NativePreferences.shared.font(size: 11, surface: "sidebar").monospaced()).foregroundStyle(FDTheme.subtle)
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
                                for task in scopeTasks where task.unread { try await NativeTaskActions.markRead(task, store: store) }
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

    @ViewBuilder private var projectTaskGroups: some View {
        let included = page.includedIDs
        let tasks = visibleTasks
        let allPinned = tasks.filter { $0.raw["is_pinned_in_project"].bool }
        let pinned = allPinned.filter { included.contains($0.id) }
        if !allPinned.isEmpty {
            Section {
                ForEach(pinned) { task in taskRow(task) }
            } header: {
                Label("Pinned in project", systemImage: "pin").font(NativePreferences.shared.font(size: 12, surface: "sidebar", weight: .medium))
            }
        }
        ForEach(folders) { folder in
            let members = tasks.filter { folder.taskIDs.contains($0.id) && !$0.raw["is_pinned_in_project"].bool }
            Section {
                if isFolderExpanded(folder) {
                    ForEach(members.filter { included.contains($0.id) }) { task in taskRow(task) }
                    if members.isEmpty {
                        Text("Drop tasks here").font(NativePreferences.shared.font(size: 11, surface: "sidebar")).foregroundStyle(FDTheme.subtle)
                            .padding(.leading, 18).padding(.vertical, 5)
                    }
                }
            } header: {
                folderHeader(folder, count: members.count)
            }
        }
        let folderIDs = folders.reduce(into: Set<String>()) { $0.formUnion($1.taskIDs) }
        let root = tasks.filter { included.contains($0.id) && !folderIDs.contains($0.id) && !$0.raw["is_pinned_in_project"].bool }
        Section {
            ForEach(root) { task in taskRow(task) }
        } header: {
            if !folders.isEmpty || !allPinned.isEmpty {
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

    private var showMoreTasks: some View {
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

    private func scrollToSelection(_ proxy: ScrollViewProxy) {
        guard let id = store.selectedTaskID, page.includedIDs.contains(id) else { return }
        Task { @MainActor in
            await Task.yield()
            guard store.selectedTaskID == id else { return }
            proxy.scrollTo(id, anchor: .center)
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            if archived {
                Button { archived = false } label: { Label("Back to active tasks", systemImage: "arrow.uturn.backward") }
                    .buttonStyle(.plain)
            } else {
                Button { newTask() } label: {
                    Label(store.selectedSection == "chats" ? "New chat" : "New task", systemImage: "plus")
                }
                .buttonStyle(.plain)
                .disabled(!store.isConnected)
            }
            Spacer()
            if isProject, let projectID {
                Button { createFolder(projectID) } label: { Image(systemName: "folder.badge.plus") }
                    .buttonStyle(NativeIconButtonStyle()).help("New folder").accessibilityLabel("New folder")
            }
        }
        .font(NativePreferences.shared.font(size: 13, surface: "sidebar", weight: .medium)).foregroundStyle(FDTheme.secondary)
        .padding(.horizontal, 16).padding(.vertical, 12)
        .overlay(alignment: .top) { FDTheme.hairline.frame(height: 1) }
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
        hostExtensionStates = extensionSources.mapValues(NativeSidebarExtensions.init)
    }

    private func refreshOrder() {
        orderedIDs = ordering.ordered(scopeTasks.filter(matches), mode: sort, scope: "\(store.selectedSection):\(projectID ?? "")")
    }

    private func newTask(folder: String? = nil) {
        archived = false
        if store.selectedSection == "chats" || store.selectedProject == nil {
            Task { await store.newChat() }
        } else if let folder, let projectID {
            NativeTaskActions.perform(store) {
                let handle = try await store.request(path: "/api/workspaces/\(projectID)/threads", method: "POST", body: .object([
                    "workspace_id": .string(projectID), "provider": .string(store.provider)
                ]))
                let task = AgentTask(handle["thread"])
                try await NativeTaskActions.move(task, to: folder, store: store)
                await store.refresh()
                await store.selectTask(task.id)
            }
        } else {
            store.selectSection(store.selectedProject?.raw["kind"].string == "casual" ? "chats" : "project")
            store.newTask()
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
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if task.unread { Circle().fill(FDTheme.info).frame(width: 5, height: 5).accessibilityLabel("Unread") }
                Text(task.title).font(NativePreferences.shared.font(size: 14, surface: "sidebar", weight: task.unread ? .semibold : .medium))
                    .foregroundStyle(FDTheme.foreground).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                TaskStatusMark(status: task.status)
            }
            if !task.preview.isEmpty {
                Text(task.preview.replacingOccurrences(of: "\n", with: " "))
                    .font(NativePreferences.shared.font(size: 12, surface: "sidebar")).foregroundStyle(FDTheme.muted).lineLimit(2).lineSpacing(3)
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
                if let date = NavigationTaskDate.date(task.updatedAt) { Text(date, style: .relative).lineLimit(1) }
            }
            .font(NativePreferences.shared.font(size: 11, surface: "sidebar")).foregroundStyle(FDTheme.subtle)
        }
        .padding(.horizontal, 7).padding(.vertical, 9).contentShape(.rect)
    }
}

@MainActor private enum NavigationTaskDate {
    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    static let standard = ISO8601DateFormatter()
    static func date(_ text: String) -> Date? { fractional.date(from: text) ?? standard.date(from: text) }
}
