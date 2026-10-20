import AppKit
import SwiftUI

struct WorkspaceView: View {
    @Bindable var store: AppStore
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            projectSidebar
                .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 280)
        } content: {
            taskList
                .navigationSplitViewColumnWidth(min: 240, ideal: 290, max: 390)
        } detail: {
            ConversationView(store: store)
                .frame(minWidth: 460)
        }
        .navigationSplitViewStyle(.balanced)
        .navigationTitle("FalconDeck")
        .tint(FDTheme.accent)
        .preferredColorScheme(.dark)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    store.newTask()
                } label: {
                    Label("New task", systemImage: "square.and.pencil")
                }
                .keyboardShortcut("n", modifiers: .command)
                .help("New task (⌘N)")
                .disabled(store.selectedProject == nil)
                .accessibilityIdentifier("new-task-toolbar")
            }
        }
    }

    private var projectSelection: Binding<String?> {
        Binding(get: { store.selectedProjectID }, set: { id in
            if let id { store.selectProject(id) }
        })
    }

    private var taskSelection: Binding<String?> {
        Binding(get: { store.selectedTaskID }, set: { id in
            if let id { Task { await store.selectTask(id) } }
        })
    }

    private var projectSidebar: some View {
        let activity = store.tasks.reduce(into: [String: ProjectActivity]()) { result, task in
            guard !task.raw["is_archived"].bool else { return }
            result[task.projectID, default: ProjectActivity()].count += 1
            if task.status == "running" { result[task.projectID, default: ProjectActivity()].running = true }
        }
        return VStack(spacing: 0) {
            HStack {
                Text("WORKSPACE")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .tracking(1.4)
                    .foregroundStyle(FDTheme.subtle)
                Spacer()
                Text("\(store.projects.count)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(FDTheme.subtle)
            }
            .padding(.horizontal, 18)
            .padding(.top, 19)
            .padding(.bottom, 12)

            if store.projects.isEmpty {
                VStack(spacing: 10) {
                    if store.isLoading { MacActivityDiamond() }
                    Text(store.isConnected ? "No projects yet" : "Connecting to your Mac…")
                        .font(.system(size: 12))
                        .foregroundStyle(FDTheme.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: projectSelection) {
                    ForEach(store.projects) { project in
                        ProjectSidebarRow(
                            project: project,
                            taskCount: activity[project.id]?.count ?? 0,
                            running: activity[project.id]?.running ?? false
                        )
                        .tag(project.id)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 4, leading: 10, bottom: 4, trailing: 10))
                        .accessibilityIdentifier("project-\(project.name)")
                    }
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
            }

            Button(action: openProject) {
                Label("Open project…", systemImage: "folder.badge.plus")
                    .font(.system(size: 12))
                    .foregroundStyle(FDTheme.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!store.isConnected)
            .accessibilityIdentifier("open-project")

            connectionFooter
        }
        .background(FDTheme.surface)
    }

    private func openProject() {
        let panel = NSOpenPanel()
        panel.title = "Open project"
        panel.prompt = "Open project"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in await store.openProject(path: url.path) }
        }
    }

    private var connectionFooter: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(store.isConnected ? FDTheme.accent : FDTheme.warning)
                .frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 3) {
                Text(store.isConnected ? "Local daemon" : "Connection")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(FDTheme.secondary)
                Text(store.connectionStatus)
                    .font(.system(size: 10))
                    .foregroundStyle(FDTheme.subtle)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button {
                Task { await store.reconnect() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(NativeIconButtonStyle())
            .help("Reconnect to the local daemon")
            .accessibilityLabel("Reconnect")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .overlay(alignment: .top) { FDTheme.hairline.frame(height: 1) }
    }

    private var taskList: some View {
        let tasks = store.filteredTasks
        return VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 13) {
                HStack(alignment: .firstTextBaseline) {
                    Text(store.selectedProject?.name ?? "Tasks")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(FDTheme.foreground)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text("\(tasks.count)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(FDTheme.subtle)
                }
                HStack(spacing: 7) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(FDTheme.subtle)
                    TextField("Search tasks", text: $store.searchText)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .accessibilityIdentifier("task-search")
                    if !store.searchText.isEmpty {
                        Button { store.searchText = "" } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(FDTheme.subtle)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear search")
                    }
                }
                .font(.system(size: 11))
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(FDTheme.raised, in: .rect(cornerRadius: 7))
                .overlay { RoundedRectangle(cornerRadius: 7).strokeBorder(FDTheme.hairline) }
            }
            .padding(16)

            Rectangle().fill(FDTheme.hairline).frame(height: 1)

            if tasks.isEmpty {
                NativeEmptyState(
                    symbol: store.searchText.isEmpty ? "text.bubble" : "magnifyingglass",
                    title: store.searchText.isEmpty ? "A fresh start" : "No matching tasks",
                    detail: store.searchText.isEmpty ? "Create a task to start working in this project." : "Try another name or clear your search."
                )
            } else {
                List(selection: taskSelection) {
                    ForEach(tasks) { task in
                        TaskListRow(task: task)
                            .tag(task.id)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 5, leading: 10, bottom: 5, trailing: 10))
                            .accessibilityIdentifier("task-\(task.id)")
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }

            Button {
                store.newTask()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "plus")
                    Text("New task").fontWeight(.medium)
                    Spacer()
                    Text("⌘N").font(.system(size: 10, design: .monospaced)).foregroundStyle(FDTheme.subtle)
                }
                .font(.system(size: 12))
                .foregroundStyle(FDTheme.secondary)
                .padding(12)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(store.selectedProject == nil)
            .padding(8)
            .overlay(alignment: .top) { FDTheme.hairline.frame(height: 1) }
            .accessibilityIdentifier("new-task-list")
        }
        .background(FDTheme.surface)
    }
}

private struct ProjectActivity {
    var count = 0
    var running = false
}

private struct ProjectSidebarRow: View {
    let project: Project
    let taskCount: Int
    let running: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "folder")
                .font(.system(size: 14))
                .foregroundStyle(FDTheme.muted)
                .frame(width: 20)
            Text(project.name)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(FDTheme.foreground)
                .lineLimit(1)
            Spacer(minLength: 0)
            if running {
                MacActivityDiamond(size: 7)
            } else {
                Text("\(taskCount)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(FDTheme.subtle)
            }
        }
        .padding(.vertical, 7)
        .help(project.path)
    }
}

private struct TaskListRow: View {
    let task: AgentTask

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(task.title.isEmpty ? "New task" : task.title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(FDTheme.foreground)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                TaskStatusMark(status: task.status)
            }
            if !task.preview.isEmpty {
                Text(task.preview.replacingOccurrences(of: "\n", with: " "))
                    .font(.system(size: 11))
                    .foregroundStyle(FDTheme.muted)
                    .lineLimit(2)
                    .lineSpacing(3)
            }
            HStack(spacing: 5) {
                Text(FDTheme.providerName(task.provider))
                if task.status == "running" {
                    Text("·")
                    Text("Working").foregroundStyle(FDTheme.accent)
                } else if ["awaiting_approval", "waiting_for_input"].contains(task.status) {
                    Text("·")
                    Text(FDTheme.statusLabel(task.status)).foregroundStyle(FDTheme.warning)
                }
                Spacer()
                if let date = TaskDateFormatter.date(task.updatedAt) {
                    Text(date, style: .relative)
                        .lineLimit(1)
                }
            }
            .font(.system(size: 10))
            .foregroundStyle(FDTheme.subtle)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 9)
        .contentShape(.rect)
    }
}

@MainActor private enum TaskDateFormatter {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let standard = ISO8601DateFormatter()

    static func date(_ text: String) -> Date? {
        fractional.date(from: text) ?? standard.date(from: text)
    }
}
