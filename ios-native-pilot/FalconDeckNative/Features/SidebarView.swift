import SwiftUI

private enum SidebarOptionsAction { case reorder, filters }

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.nativeMotion) private var motion
    let openDetail: () -> Void
    @State private var search = ""
    @State private var messageMatches: [JSON] = []
    @State private var searchingMessages = false
    @State private var messageSearchError: String?
    @State private var showOptions = false
    @State private var deferredOptionsAction: SidebarOptionsAction?
    @State private var chatsExpanded = true
    @State private var optionsProject: Project?
    @State private var reorder = false
    @State private var filters = false
    @AppStorage("native.sidebar.sort") private var sort = "last_updated"
    @State private var expanded: Set<String> = []
    @State private var limits: [String: Int] = [:]
    @State private var showHidden = false
    @State private var pinsExpanded = true
    @State private var folderName = ""
    @State private var folderProject = ""
    @State private var editingFolder: ProjectFolder?
    @State private var showFolderEditor = false
    @State private var deleteFolder: ProjectFolder?
    @State private var disclosures = FolderDisclosures()

    private var projects: [Project] {
        let hidden = Set(model.preferences["hidden_workspace_ids"].array.map(\.string))
        return model.sortedProjects.filter {
            !model.botWorkspaceIDs.contains($0.id) && ($0.raw["kind"].string == "casual" || showHidden || !hidden.contains($0.id)) && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || model.tasks(in: $0).contains { $0.title.localizedCaseInsensitiveContains(search) })
        }
    }
    private var pins: [AgentTask] { model.tasks.filter { $0.pinned && matches($0) }.sorted { $0.updatedAt > $1.updatedAt } }
    var body: some View {
        let projects = projects
        let pins = pins
        let folders = model.folders
        let projectGroups = projects.filter { $0.raw["kind"].string != "casual" }
        let projectsOpen = !search.isEmpty || projectGroups.contains { expanded.contains($0.id) }
        let pinsOpen = pinsExpanded || !search.isEmpty
        let chatsOpen = chatsExpanded || !search.isEmpty
        let casual = projects.filter { $0.raw["kind"].string == "casual" }
        let plan = TaskPagePlan(connectionID: model.connectionID, token: model.syncIndex?.token, connected: model.connected, sort: sort,
            scopes: initialScopes(projectGroups, casual: chatsOpen ? casual : [], folders: folders))
        List {
            Group {
                sidebarAction("New chat", symbol: "square.and.pencil") { Task { if await model.newChat() != nil { openDetail() } } }
                    .disabled(!model.demo && !model.connected).accessibilityIdentifier("sidebar-new-chat")
                sidebarAction("Activity", symbol: "tray.full", selected: model.selection == .activity) { navigate(.activity) }
                NativeBotsSection(search: search, openDetail: openDetail)
                    .id(model.connectionID)
                if !pins.isEmpty {
                    sectionHeading("Pinned", expanded: pinsOpen) { animate { pinsExpanded.toggle() } }
                    if pinsOpen { ForEach(pins) { taskLink($0, projectIcon: true) } }
                }
                sectionHeading("Projects", expanded: projectsOpen) {
                    animate { if projectsOpen { expanded.subtract(projectGroups.map(\.id)) } else { expanded.formUnion(projectGroups.map(\.id)) } }
                }
                ForEach(projectGroups) { project in
                    let isOpen = expanded.contains(project.id) || !search.isEmpty
                    HStack(spacing: 0) {
                    Button {
                        animate { if expanded.contains(project.id) { expanded.remove(project.id) } else { expanded.insert(project.id) } }
                    } label: {
                        HStack(spacing: 8) {
                            NativeDisclosureChevron(expanded: isOpen).foregroundStyle(FD.muted).frame(width: 12)
                            WorkspaceGlyph(project: project).font(.subheadline).frame(width: 18, height: 20)
                            Text(project.name).font(.subheadline.weight(.medium)).lineLimit(1)
                            Spacer(minLength: 2)
                            if model.tasks(in: project).contains(where: \.working) { ActivityDiamond() }
                        }.padding(.horizontal, 10).frame(minHeight: 44).contentShape(.rect)
                    }
                    .buttonStyle(NativePressStyle(scales: false, feedback: .selection)).foregroundStyle(FD.foreground).disabled(!search.isEmpty)
                    .accessibilityIdentifier("project-\(project.name)").accessibilityValue(isOpen ? "Expanded" : "Collapsed")
                    Button { newTask(project) } label: {
                        Image(systemName: "square.and.pencil").font(.caption).foregroundStyle(FD.muted)
                            .frame(width: 44, height: 44).contentShape(.rect)
                    }.buttonStyle(.plain).accessibilityLabel("New task in \(project.name)")
                    }
                    .contextMenu {
                        Button { newTask(project) } label: { Label("New task", systemImage: "square.and.pencil") }
                        Button { editFolder(projectID: project.id) } label: { Label("New folder", systemImage: "folder.badge.plus") }
                        Button("Project options", systemImage: "slider.horizontal.3") { optionsProject = project }
                        ShareLink(item: project.path) { Label("Share project path", systemImage: "square.and.arrow.up") }
                    }
                    if isOpen { projectContents(project, folders: folders.filter { $0.projectID == project.id }) }
                }
                if !casual.isEmpty {
                    sectionHeading("Chats", expanded: chatsOpen) { animate { chatsExpanded.toggle() } }
                    if chatsOpen { chatContents(casual) }
                }
                if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            if searchingMessages { ActivityDiamond() }
                            Text("Conversation messages").font(.caption).foregroundStyle(FD.secondary)
                        }
                        ForEach(Array(messageMatches.enumerated()), id: \.offset) { _, match in
                            Button {
                                Task {
                                    await model.openTask(match["thread_id"].string)
                                    if model.selection == .task(match["thread_id"].string) { openDetail() }
                                }
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(model.task(match["thread_id"].string)?.title.nonempty ?? "Open conversation").font(.subheadline)
                                    Text(match["snippet"].string).font(.caption).foregroundStyle(FD.secondary).lineLimit(3)
                                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(.rect)
                            }.buttonStyle(.plain)
                        }
                        if let messageSearchError {
                            Text(messageSearchError).font(.caption).foregroundStyle(.orange)
                            Button("Retry search") { Task { await searchMessages() } }
                        } else if !searchingMessages && messageMatches.isEmpty {
                            Text("No matching messages").font(.caption).foregroundStyle(FD.secondary)
                        }
                    }.padding(12)
                }
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange).padding(12)
                    Button("Dismiss error") { model.error = nil }.font(.caption).padding(.horizontal, 12)
                }
            }
            .listRowInsets(EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10))
            .listRowSeparator(.hidden).listRowBackground(Color.clear)
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 0)
        .contentMargins(.top, 0, for: .scrollContent).contentMargins(.bottom, 16, for: .scrollContent)
        .background(FD.background).navigationTitle("Tasks").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search tasks")
        .safeAreaInset(edge: .top, spacing: 0) { NativeSyncBanner() }
        .overlay {
            if model.projects.isEmpty && model.tasks.isEmpty && model.hasSession && !model.hasLiveSnapshot {
                NativeLoadingState(label: model.networkAvailable ? "Loading tasks…" : "Waiting for a connection")
                    .accessibilityIdentifier("sidebar-loading").allowsHitTesting(false)
            }
        }
        .refreshable { await model.refresh() }
        .task(id: plan) { await model.loadInitialTaskPages(plan) }
        .task(id: "\(model.connectionID):\(model.connected):\(search)") { await searchMessages() }
        .onChange(of: model.connectionID) { _, _ in disclosures.reset() }
        .sensoryFeedback(.selection, trigger: showOptions) { _, open in open && motion.active }
        .toolbar {
            ToolbarItem(placement: .bottomBar) {
                Button { navigate(.settings) } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings").accessibilityIdentifier("sidebar-settings")
            }
            ToolbarItem(placement: .bottomBar) { Spacer() }
            ToolbarItem(placement: .bottomBar) {
                Button { showOptions = true } label: { Label("Options", systemImage: "slider.horizontal.3") }
                    .accessibilityLabel("Sidebar options")
            }
        }
        .sheet(isPresented: $showOptions, onDismiss: {
            switch deferredOptionsAction { case .reorder: reorder = true; case .filters: filters = true; case nil: break }
            deferredOptionsAction = nil
        }) {
            NavigationStack {
                Form {
                    Section("Task order") {
                        Picker("Sort tasks", selection: $sort) {
                            Text("Last updated").tag("last_updated"); Text("Priority").tag("priority"); Text("Name").tag("alphabetical")
                        }.pickerStyle(.inline).labelsHidden()
                    }.listRowBackground(FD.surface)
                    Section("Projects") {
                        Toggle("Show hidden projects", isOn: $showHidden)
                        Button("Reorder projects", systemImage: "arrow.up.arrow.down") { deferredOptionsAction = .reorder; showOptions = false }
                        Button("Collapse all projects", systemImage: "rectangle.compress.vertical") { expanded = []; showOptions = false }
                    }.listRowBackground(FD.surface)
                    Section {
                        if !model.extensions.filters.isEmpty { Button("Filter tasks", systemImage: "line.3.horizontal.decrease") { deferredOptionsAction = .filters; showOptions = false } }
                        Button("Automations", systemImage: "calendar.badge.clock") { showOptions = false; navigate(.automations) }
                        Button("Archived tasks", systemImage: "archivebox") { showOptions = false; navigate(.archived) }
                    }.listRowBackground(FD.surface)
                }.scrollContentBackground(.hidden).background(FD.background)
                    .navigationTitle("Sidebar options").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showOptions = false } } }
            }.nativeOptionsSheet()
        }
        .sheet(item: $optionsProject) { ProjectOptionsView(project: $0) }
        .sheet(isPresented: $reorder) { ProjectOrderView() }
        .sheet(isPresented: $filters) { ExtensionFiltersView() }
        .onAppear {
            if case .task(let id) = model.selection, let task = model.tasks.first(where: { $0.id == id }) { expanded.insert(task.projectID) }
            else if expanded.isEmpty, let project = projects.first(where: { $0.raw["kind"].string != "casual" }) { expanded.insert(project.id) }
        }
        .onChange(of: model.selection) { _, destination in
            guard case .task(let id) = destination, let task = model.task(id), !task.pinned else { return }
            expanded.insert(task.projectID)
            if let folder = model.folders.first(where: { $0.taskIDs.contains(id) }) { disclosures.reveal(folder.id) }
        }
        .onChange(of: model.projects.isEmpty) { _, empty in
            if !empty && expanded.isEmpty, let project = projects.first(where: { $0.raw["kind"].string != "casual" }) { expanded.insert(project.id) }
        }
        .alert(editingFolder == nil ? "New folder" : "Rename folder", isPresented: $showFolderEditor) {
            TextField("Folder name", text: $folderName)
            Button("Cancel", role: .cancel) { }
            Button("Save") {
                Task {
                    do { try await model.folderMutation(projectID: folderProject, action: editingFolder == nil ? "create" : "rename", folderID: editingFolder?.id, name: folderName.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    catch { model.error = error.localizedDescription }
                }
            }.disabled(folderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .confirmationDialog("Delete this folder?", isPresented: Binding(get: { deleteFolder != nil }, set: { if !$0 { deleteFolder = nil } })) {
            Button("Delete folder", role: .destructive) {
                guard let folder = deleteFolder else { return }
                Task {
                    do { try await model.folderMutation(projectID: folder.projectID, action: "delete", folderID: folder.id) }
                    catch { model.error = error.localizedDescription }
                }
            }
        } message: { Text("Its tasks return to the project. They will not be archived.") }
    }

    @MainActor private func searchMessages() async {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let connection = model.connectionID
        messageMatches = []; messageSearchError = nil; searchingMessages = false
        guard !query.isEmpty else { return }
        guard model.connected else { messageSearchError = "Connect to your computer to search messages."; return }
        searchingMessages = true
        do {
            try await Task.sleep(for: .milliseconds(300))
            let response = try await model.relay.call("thread.search", params: .object(["query": .string(query), "limit": .number(12)]))
            guard !Task.isCancelled, connection == model.connectionID, query == search.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
            messageMatches = response["matches"].array
            searchingMessages = false
        } catch {
            guard !Task.isCancelled, connection == model.connectionID, query == search.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
            messageSearchError = error.localizedDescription; searchingMessages = false
        }
    }

    @ViewBuilder private func projectContents(_ project: Project, folders: [ProjectFolder]) -> some View {
        let tasks = model.tasks(in: project).filter { !$0.pinned && matches($0, project: project) }
        let filed = folders.reduce(into: Set<String>()) { $0.formUnion($1.taskIDs) }
        ForEach(tasks.filter(\.pinnedInProject)) { taskLink($0, indent: 20) }
        ForEach(folders) { folder in
            let isOpen = !search.isEmpty || disclosures.isExpanded(folder)
            Button {
                animate { disclosures.toggle(folder, model: model) }
            } label: {
                HStack {
                    Label(folder.name, systemImage: "folder").font(.subheadline)
                    Spacer()
                    NativeDisclosureChevron(expanded: isOpen, size: 12)
                }.foregroundStyle(FD.secondary).padding(.leading, 26).padding(.trailing, 10).frame(minHeight: 44).contentShape(.rect)
            }
            .buttonStyle(NativePressStyle(scales: false, feedback: .selection))
            .disabled(!search.isEmpty).accessibilityValue(isOpen ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("sidebar-folder-\(folder.id)")
            .contextMenu {
                Button { newTask(project, folderID: folder.id) } label: { Label("New task", systemImage: "square.and.pencil") }
                Button { editFolder(projectID: project.id, folder: folder) } label: { Label("Rename folder", systemImage: "pencil") }
                Button("Delete folder", systemImage: "trash", role: .destructive) { deleteFolder = folder }
            }
            if isOpen {
                let members = folder.taskIDs
                taskPage(tasks.filter { members.contains($0.id) && !$0.pinnedInProject }, key: folder.id, indent: 40, folder: folder)
            }
        }
        taskPage(tasks.filter { !$0.pinnedInProject && !filed.contains($0.id) }, key: project.id, indent: 20)
    }
    @ViewBuilder private func taskPage(_ tasks: [AgentTask], key: String, indent: CGFloat, folder: ProjectFolder? = nil) -> some View {
        let limit = search.isEmpty ? limits[key, default: 5] : tasks.count
        let ordered = sorted(tasks)
        ForEach(ordered.prefix(limit)) { taskLink($0, indent: indent) }
        if case .task(let selectedID) = model.selection, let selected = ordered.dropFirst(limit).first(where: { $0.id == selectedID }) {
            taskLink(selected, indent: indent)
        }
        let projectID = folder?.projectID ?? key
        let loading = model.taskPageLoads.contains(CompactSync.key(project: projectID, folder: folder?.id, sort: sort))
        if tasks.isEmpty, loading {
            HStack(spacing: 8) { ActivityDiamond(); Text("Loading tasks…").font(.caption).foregroundStyle(FD.secondary) }
                .padding(.leading, indent + 28).frame(minHeight: 44)
        } else if tasks.count > limit || model.hasMoreTasks(projectID, folderID: folder?.id, sort: sort) {
            Button {
                limits[key] = limit + 10
                Task { await model.loadTaskPage(projectID, folderID: folder?.id, sort: sort) }
            } label: { HStack(spacing: 8) { if loading { ActivityDiamond() }; Text("Show more") } }
                .font(.caption).foregroundStyle(FD.secondary).padding(.leading, indent + 28).frame(minHeight: 44).disabled(loading)
        }
    }

    private func initialScopes(_ projects: [Project], casual: [Project], folders: [ProjectFolder]) -> [TaskPageScope] {
        projects.filter { expanded.contains($0.id) || !search.isEmpty }.flatMap { project in
            [TaskPageScope(projectID: project.id)] + folders.filter {
                $0.projectID == project.id && (!search.isEmpty || disclosures.isExpanded($0))
            }.map { TaskPageScope(projectID: project.id, folderID: $0.id) }
        } + casual.map { TaskPageScope(projectID: $0.id) }
    }

    @ViewBuilder private func chatContents(_ projects: [Project]) -> some View {
        let all = projects.flatMap { model.tasks(in: $0) }.filter { !$0.pinned && matches($0) }
        let tasks = sorted(all.filter(\.pinnedInProject)) + sorted(all.filter { !$0.pinnedInProject })
        let limit = search.isEmpty ? limits["chats", default: 10] : tasks.count
        let next = projects.first { model.hasMoreTasks($0.id, sort: sort) }
        let loading = projects.contains { model.taskPageLoads.contains(CompactSync.key(project: $0.id, folder: nil, sort: sort)) }
        ForEach(tasks.prefix(limit)) { taskLink($0) }
        if case .task(let selectedID) = model.selection, let selected = tasks.dropFirst(limit).first(where: { $0.id == selectedID }) { taskLink(selected) }
        if tasks.isEmpty && loading {
            HStack(spacing: 8) { ActivityDiamond(); Text("Loading chats…").font(.caption).foregroundStyle(FD.secondary) }
                .frame(maxWidth: .infinity, minHeight: 64).accessibilityIdentifier("sidebar-chats-loading")
        } else if tasks.count > limit || next != nil {
            Button {
                limits["chats"] = limit + 10
                if let next { Task { await model.loadTaskPage(next.id, sort: sort) } }
            } label: { HStack(spacing: 8) { if loading { ActivityDiamond() }; Text("Show more") } }
                .font(.caption).foregroundStyle(FD.secondary).padding(.leading, 28).frame(minHeight: 44)
                .disabled(loading).accessibilityIdentifier("sidebar-chats-more")
        }
    }
    private func taskLink(_ task: AgentTask, indent: CGFloat = 0, projectIcon: Bool = false) -> some View {
        Button { navigate(.task(task.id)) } label: {
            HStack(spacing: 8) {
                if projectIcon, let project = model.projects.first(where: { $0.id == task.projectID }) {
                    WorkspaceGlyph(project: project).font(.subheadline).frame(width: 18, height: 20)
                }
                Group {
                    if task.working { ActivityDiamond() }
                    else if task.needsAttention { Circle().fill(.orange).frame(width: 6, height: 6) }
                    else if task.unread { Circle().fill(NativeAppearance.shared.color("unread")).frame(width: 6, height: 6) }
                    else { Color.clear }
                }.frame(width: 12, height: 14)
                Text(task.title.nonempty ?? "New task").font(.subheadline).lineLimit(1)
                    .foregroundStyle(model.selection == .task(task.id) ? FD.foreground : FD.secondary)
                Spacer(minLength: 4)
                TaskStageMark(task: task).font(.caption2)
            }
            .padding(.leading, indent + 10).padding(.trailing, 12).frame(minHeight: 44)
            .background(model.selection == .task(task.id) ? FD.raised : .clear, in: .rect(cornerRadius: 8))
            .contentShape(.rect)
        }.buttonStyle(.plain).accessibilityIdentifier("sidebar-task-\(task.id)")
            .accessibilityValue("\(task.provider.capitalized), \(task.awaitingInput ? "Needs input" : task.working ? "Running" : task.unread ? "Unread" : "Ready")")
            .accessibilityAddTraits(model.selection == .task(task.id) ? .isSelected : [])
            .contextMenu { TaskStageMenu(task: task); TaskActions(task: task) }
            .swipeActions(edge: .leading) { TaskReadButton(task: task).tint(FD.accent) }
    }
    private func sidebarAction(_ title: String, symbol: String, selected: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol).font(.subheadline).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 12).background(selected ? FD.raised : .clear, in: .rect(cornerRadius: 8)).contentShape(.rect)
        }.buttonStyle(.plain).foregroundStyle(FD.foreground)
    }
    private func sectionHeading(_ title: String, expanded: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title.uppercased()).font(.system(.caption2, design: .monospaced).weight(.medium)).tracking(0.8)
                Spacer()
                NativeDisclosureChevron(expanded: expanded)
            }.foregroundStyle(FD.muted).padding(.horizontal, 12).frame(minHeight: 40).padding(.top, 8).contentShape(.rect)
        }.buttonStyle(NativePressStyle(scales: false, feedback: .selection)).disabled(!search.isEmpty).accessibilityIdentifier("sidebar-section-\(title.lowercased())")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    }
    private func animate(_ changes: () -> Void) { withAnimation(motion.interactionAnimation, changes) }
    private func matches(_ task: AgentTask, project: Project? = nil) -> Bool {
        !model.botTaskIDs.contains(task.id) && model.extensions.matches(task) && (search.isEmpty || task.title.localizedCaseInsensitiveContains(search) || project?.name.localizedCaseInsensitiveContains(search) == true)
    }
    private func sorted(_ tasks: [AgentTask]) -> [AgentTask] {
        tasks.sorted { left, right in
            if sort == "alphabetical" { return left.title.localizedStandardCompare(right.title) == .orderedAscending }
            if sort == "priority" {
                let lhs = left.awaitingInput ? 0 : left.unread ? 1 : left.working ? 2 : 3
                let rhs = right.awaitingInput ? 0 : right.unread ? 1 : right.working ? 2 : 3
                if lhs != rhs { return lhs < rhs }
            }
            return left.updatedAt > right.updatedAt
        }
    }
    private func newTask(_ project: Project, folderID: String? = nil) {
        navigate(.draft(project.id, folderID))
    }
    private func navigate(_ destination: Destination) {
        model.selection = destination
        openDetail()
    }
    private func editFolder(projectID: String, folder: ProjectFolder? = nil) {
        folderProject = projectID; editingFolder = folder; folderName = folder?.name ?? ""; showFolderEditor = true
    }
}

struct TaskActions: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    var body: some View {
        Button { model.taskOptionsID = task.id } label: { Label("Task options", systemImage: "ellipsis") }
        TaskReadButton(task: task)
        Button { Task { await model.updateTask(task, fields: ["pinned": .bool(!task.pinned)]) } } label: { Label(task.pinned ? "Unpin" : "Pin", systemImage: "pin") }
        Button { Task { await model.updateTask(task, fields: ["pinned_in_project": .bool(!task.pinnedInProject)]) } } label: { Label(task.pinnedInProject ? "Unpin in project" : "Pin in project", systemImage: "pin.circle") }
        Menu("Move to folder", systemImage: "folder") {
            Button("Project root") { move(nil) }
            ForEach(model.folders.filter { $0.projectID == task.projectID }) { folder in Button(folder.name) { move(folder.id) } }
        }
        Divider()
        ShareLink(item: task.title) { Label("Share task title", systemImage: "square.and.arrow.up") }
        Divider()
        Button("Archive task", systemImage: "archivebox", role: .destructive) { Task { await model.archive(task) } }
    }
    private func move(_ id: String?) {
        Task {
            do { try await model.folderMutation(projectID: task.projectID, action: "move_thread", folderID: id, taskID: task.id) }
            catch { model.error = error.localizedDescription }
        }
    }
}

struct TaskReadButton: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    var action: (() -> Void)? = nil
    var body: some View {
        Button(task.unread ? "Mark read" : "Mark unread", systemImage: task.unread ? "envelope.open" : "envelope.badge") {
            if let action { action() }
            else { Task { await model.markRead(task, unread: !task.unread) } }
        }
        .disabled(task.isDraft || task.activitySeq == 0 || (!model.demo && !model.connected))
        .accessibilityIdentifier("task-toggle-read")
    }
}
