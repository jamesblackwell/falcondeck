import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @State private var search = ""
    @State private var expanded: Set<String> = []
    @State private var limits: [String: Int] = [:]
    @State private var showHidden = false
    @State private var pinsExpanded = true
    @State private var folderName = ""
    @State private var folderProject = ""
    @State private var editingFolder: ProjectFolder?
    @State private var showFolderEditor = false
    @State private var deleteFolder: ProjectFolder?

    private var projects: [Project] {
        let hidden = Set(model.preferences["hidden_workspace_ids"].array.map(\.string))
        return model.sortedProjects.filter {
            (showHidden || !hidden.contains($0.id)) && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || model.tasks(in: $0).contains { $0.title.localizedCaseInsensitiveContains(search) })
        }
    }
    private var pins: [AgentTask] { model.tasks.filter { $0.pinned && matches($0) }.sorted { $0.updatedAt > $1.updatedAt } }
    var body: some View {
        @Bindable var model = model
        List(selection: $model.selection) {
            Section {
                NavigationLink(value: Destination.projects) { Label("Projects", systemImage: "square.grid.2x2") }
                NavigationLink(value: Destination.activity) {
                    HStack { Label("Activity", systemImage: "waveform.path"); Spacer(); Text("\(model.tasks.filter(\.running).count)").foregroundStyle(FD.secondary) }
                }
            }
            if !pins.isEmpty {
                Section("Pinned", isExpanded: $pinsExpanded) { ForEach(pins) { taskLink($0) } }
            }
            Section("Projects") {
                ForEach(projects) { project in
                    DisclosureGroup(isExpanded: Binding(get: { expanded.contains(project.id) || !search.isEmpty }, set: { value in
                        if value { expanded.insert(project.id) } else { expanded.remove(project.id) }
                    })) {
                        if expanded.contains(project.id) || !search.isEmpty { projectContents(project) }
                    } label: {
                        HStack(spacing: 10) {
                            ProjectIcon(name: project.name).font(.subheadline).frame(width: 20, height: 24).foregroundStyle(FD.accent)
                            Text(project.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                            Spacer(minLength: 2)
                            if model.tasks(in: project).contains(where: \.running) { ActivityDiamond() }
                        }.padding(.vertical, 3)
                    }
                    .accessibilityIdentifier("project-\(project.name)")
                    .contextMenu {
                        Button { newTask(project) } label: { Label("New task", systemImage: "square.and.pencil") }
                        Button { editFolder(projectID: project.id) } label: { Label("New folder", systemImage: "folder.badge.plus") }
                        ShareLink(item: project.path) { Label("Share project path", systemImage: "square.and.arrow.up") }
                    }
                }
            }
            if model.projects.isEmpty {
                Section {
                    Button("Connect your computer") { model.showConnection = true }
                    Button("Explore demo workspace") { Task { await model.useDemo() } }
                }
            }
            Section {
                if let error = model.error {
                    Text(error).font(.footnote).foregroundStyle(.orange)
                    Button("Dismiss error") { model.error = nil }
                }
                Button { model.showConnection = true } label: {
                    HStack(spacing: 10) {
                        Image(systemName: model.demo ? "sparkle" : "lock.shield")
                        Text(model.demo ? "Demo workspace" : model.status)
                        Spacer()
                        Circle().fill(model.connected ? FD.accent : FD.secondary).frame(width: 6, height: 6)
                    }.font(.footnote).foregroundStyle(FD.secondary)
                }
            }
        }
        .listStyle(.sidebar).scrollContentBackground(.hidden).background(FD.background)
        .navigationTitle("FalconDeck")
        .searchable(text: $search, prompt: "Search projects and tasks")
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { model.newTaskProjectID = projects.first?.id; model.newTaskFolderID = nil; model.showNewTask = true } label: {
                    Image(systemName: "square.and.pencil")
                }.disabled(!model.demo && !model.connected).accessibilityLabel("New task").accessibilityIdentifier("new-task")
            }
            ToolbarItem(placement: .bottomBar) {
                Button { model.showConnection = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("Connection settings")
            }
            ToolbarItem(placement: .bottomBar) { Spacer() }
            ToolbarItem(placement: .bottomBar) {
                Menu {
                    Toggle("Show hidden projects", isOn: $showHidden)
                    Button("Collapse all projects") { expanded = [] }
                } label: { Image(systemName: "line.3.horizontal.decrease") }.accessibilityLabel("Sidebar options")
            }
        }
        .onAppear {
            if case .task(let id) = model.selection, let task = model.tasks.first(where: { $0.id == id }) { expanded.insert(task.projectID) }
            else if expanded.isEmpty, let project = projects.first { expanded.insert(project.id) }
        }
        .onChange(of: model.projects.isEmpty) { _, empty in
            if !empty && expanded.isEmpty, let project = projects.first { expanded.insert(project.id) }
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

    @ViewBuilder private func projectContents(_ project: Project) -> some View {
        let tasks = model.tasks(in: project).filter { !$0.pinned && matches($0, project: project) }
        let folders = model.folders.filter { $0.projectID == project.id }
        let filed = folders.reduce(into: Set<String>()) { $0.formUnion($1.taskIDs) }
        ForEach(tasks.filter(\.pinnedInProject)) { taskLink($0) }
        ForEach(folders) { folder in
            let children = tasks.filter { folder.taskIDs.contains($0.id) && !$0.pinnedInProject }
            DisclosureGroup(isExpanded: Binding(get: { !folder.collapsed || !search.isEmpty }, set: { value in
                Task {
                    do { try await model.folderMutation(projectID: project.id, action: "set_collapsed", folderID: folder.id, collapsed: !value) }
                    catch { model.error = error.localizedDescription }
                }
            })) {
                taskPage(children, key: folder.id)
            } label: {
                Label(folder.name, systemImage: "folder").font(.subheadline).foregroundStyle(FD.secondary)
            }
            .contextMenu {
                Button { newTask(project, folderID: folder.id) } label: { Label("New task", systemImage: "square.and.pencil") }
                Button { editFolder(projectID: project.id, folder: folder) } label: { Label("Rename folder", systemImage: "pencil") }
                Button("Delete folder", systemImage: "trash", role: .destructive) { deleteFolder = folder }
            }
        }
        taskPage(tasks.filter { !$0.pinnedInProject && !filed.contains($0.id) }, key: project.id)
        Button { newTask(project) } label: { Label("New task", systemImage: "plus").font(.subheadline).foregroundStyle(FD.secondary) }
    }
    @ViewBuilder private func taskPage(_ tasks: [AgentTask], key: String) -> some View {
        let limit = search.isEmpty ? limits[key, default: 5] : tasks.count
        ForEach(tasks.prefix(limit)) { taskLink($0) }
        if tasks.count > limit {
            Button("Show more (\(tasks.count - limit))") { limits[key] = limit + 10 }.font(.caption).foregroundStyle(FD.secondary)
        }
    }
    private func taskLink(_ task: AgentTask) -> some View {
        NavigationLink(value: Destination.task(task.id)) {
            HStack(alignment: .top, spacing: 9) {
                Group {
                    if task.running { ActivityDiamond() }
                    else if task.needsAttention { Image(systemName: "exclamationmark.circle").foregroundStyle(.orange) }
                    else { Image(systemName: "bubble.left").foregroundStyle(FD.muted) }
                }.font(.caption).frame(width: 14).padding(.top, 3)
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title.nonempty ?? "New task").font(.subheadline).lineLimit(2)
                    Text(task.provider.capitalized).font(.caption2).foregroundStyle(FD.muted)
                }
                Spacer(minLength: 0)
                if task.unread { Circle().fill(.blue).frame(width: 5, height: 5).padding(.top, 7) }
            }.padding(.vertical, 3)
        }
        .contextMenu { TaskActions(task: task) }
    }
    private func matches(_ task: AgentTask, project: Project? = nil) -> Bool {
        search.isEmpty || task.title.localizedCaseInsensitiveContains(search) || project?.name.localizedCaseInsensitiveContains(search) == true
    }
    private func newTask(_ project: Project, folderID: String? = nil) {
        model.newTaskProjectID = project.id; model.newTaskFolderID = folderID; model.showNewTask = true
    }
    private func editFolder(projectID: String, folder: ProjectFolder? = nil) {
        folderProject = projectID; editingFolder = folder; folderName = folder?.name ?? ""; showFolderEditor = true
    }
}

struct TaskActions: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    var body: some View {
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
