import AppKit
import SwiftUI

/// The command palette shares navigation with the sidebars and augments title
/// matches with the daemon's indexed user-message search.
struct WorkspaceSearch: View {
    let store: AppStore
    let close: () -> Void
    @State private var query = ""
    @State private var selected: String?
    @State private var messageMatches: [JSON] = []
    @State private var searching = false
    @State private var indexing = false
    @State private var searchError: String?
    @State private var searchNotice: String?
    @State private var searchIdentity = UUID()
    @State private var renaming: AgentTask?
    @FocusState private var searchFocused: Bool

    private var normalized: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var searchSources: [NativeMessageSearchSource] {
        let local: [NativeMessageSearchSource] = store.isConnected ? [.init(hostID: nil, name: "This Mac")] : []
        return local + NativeHostManager.shared.hosts.filter { $0.enabled && $0.status == .connected }
            .map { .init(hostID: $0.id, name: $0.name) }
    }
    private var searchContext: String {
        normalized + "|" + searchSources.map { $0.hostID ?? "local" }.joined(separator: "|")
    }
    private var projects: [Project] {
        guard !normalized.isEmpty else { return [] }
        return store.projects.filter { $0.name.localizedCaseInsensitiveContains(normalized) || $0.path.localizedCaseInsensitiveContains(normalized) }
    }
    private var tasks: [AgentTask] {
        let tasks = store.tasks.filter { task in
            normalized.isEmpty ? !task.raw["is_archived"].bool : task.title.localizedCaseInsensitiveContains(normalized)
                || task.preview.localizedCaseInsensitiveContains(normalized)
        }
        return Array(tasks.sorted { $0.updatedAt > $1.updatedAt }.prefix(normalized.isEmpty ? 12 : 40))
    }
    private var snippets: [JSON] {
        let visible = Set(tasks.map(\.id))
        return messageMatches.filter { !visible.contains($0["thread_id"].string) }
    }
    private var commands: [SearchCommand] {
        SearchCommand.all.filter { normalized.isEmpty || $0.name.localizedCaseInsensitiveContains(normalized) }
    }
    private var resultIDs: [String] {
        projects.map { "project:\($0.id)" } + tasks.map { "task:\($0.id)" }
            + snippets.map { "task:\($0["thread_id"].string)" } + commands.map { "command:\($0.id)" }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass").foregroundStyle(FDTheme.muted)
                TextField("Search tasks, messages, projects or commands", text: $query)
                    .textFieldStyle(.plain).font(NativePreferences.shared.font(size: 16))
                    .focused($searchFocused)
                    .onSubmit { open(selected ?? resultIDs.first) }
                    .accessibilityIdentifier("command-search-input")
                if searching { ProgressView().controlSize(.small) }
                Button("Done", action: close).keyboardShortcut(.cancelAction)
            }
            .padding(20)
            FDTheme.hairline.frame(height: 1)
            if resultIDs.isEmpty && !searching {
                NativeEmptyState(symbol: "magnifyingglass", title: "No results", detail: "Try a task name, project path or words from a message.")
            } else {
                List(selection: $selected) {
                    if !projects.isEmpty {
                        Section("Projects") {
                            ForEach(projects) { project in
                                searchRow(title: project.name, detail: project.path, symbol: "folder", id: "project:\(project.id)")
                            }
                        }
                    }
                    if !tasks.isEmpty {
                        Section(normalized.isEmpty ? "Recent tasks" : "Tasks") {
                            ForEach(tasks) { task in
                                searchRow(title: task.title, detail: taskDetail(task), symbol: task.pinned ? "pin" : "text.bubble", id: "task:\(task.id)")
                                    .contextMenu { NativeTaskContextMenu(store: store, task: task, rename: { renaming = task }) }
                            }
                        }
                    }
                    if !snippets.isEmpty {
                        Section("Message matches") {
                            ForEach(snippets, id: \.self) { match in
                                let task = store.tasks.first { $0.id == match["thread_id"].string }
                                searchRow(title: task?.title ?? "Task", detail: match["snippet"].string, symbol: "text.magnifyingglass", id: "task:\(match["thread_id"].string)")
                            }
                        }
                    }
                    if !commands.isEmpty {
                        Section("Commands") {
                            ForEach(commands) { command in
                                searchRow(title: command.name, detail: "", symbol: command.symbol, id: "command:\(command.id)")
                            }
                        }
                    }
                }
                .listStyle(.inset)
                .scrollContentBackground(.hidden)
            }
            HStack {
                if let searchError { Text(searchError).foregroundStyle(FDTheme.danger).lineLimit(2) }
                else if let searchNotice { Text(searchNotice).lineLimit(2) }
                else if indexing { Text("Message indexing is in progress; more results may appear.") }
                else { Text("↑ ↓ to select · Return to open · Esc to close") }
                Spacer()
                Text("⌘K").font(NativePreferences.shared.font(size: 12, surface: "code"))
            }
            .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.subtle)
            .padding(.horizontal, 20).padding(.vertical, 12)
            .overlay(alignment: .top) { FDTheme.hairline.frame(height: 1) }
        }
        .frame(width: 660, height: 540)
        .background(FDTheme.surface)
        .onAppear { searchFocused = true; selected = resultIDs.first }
        .onChange(of: resultIDs) { _, values in if !values.contains(selected ?? "") { selected = values.first } }
        .onKeyPress(.downArrow) { moveSelection(1); return .handled }
        .onKeyPress(.upArrow) { moveSelection(-1); return .handled }
        .onKeyPress(.return) { open(selected ?? resultIDs.first); return .handled }
        .task(id: searchContext) { await searchMessages() }
        .sheet(item: $renaming) { task in NativeTaskRenameSheet(store: store, task: task, dismiss: { renaming = nil }) }
    }

    private func searchRow(title: String, detail: String, symbol: String, id: String) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: symbol).font(NativePreferences.shared.font(size: 14)).foregroundStyle(FDTheme.muted).frame(width: 20).padding(.top, 2)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(NativePreferences.shared.font(size: 14, weight: .medium)).lineLimit(1)
                if !detail.isEmpty { Text(detail).font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted).lineLimit(2) }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 7).contentShape(.rect).tag(id)
        .onTapGesture { open(id) }
    }

    private func taskDetail(_ task: AgentTask) -> String {
        let project = store.allProjects.first { $0.id == task.projectID }
        let archived = task.raw["is_archived"].bool ? " · Archived" : ""
        return "\(project?.name ?? "Project") · \(FDTheme.providerName(task.provider))\(archived)"
    }

    private func moveSelection(_ offset: Int) {
        guard !resultIDs.isEmpty else { return }
        let index = selected.flatMap { resultIDs.firstIndex(of: $0) } ?? 0
        selected = resultIDs[min(max(index + offset, 0), resultIDs.count - 1)]
    }

    private func open(_ id: String?) {
        guard let id else { return }
        close()
        if id.hasPrefix("project:") {
            store.selectProject(String(id.dropFirst(8)))
        } else if id.hasPrefix("task:") {
            let taskID = String(id.dropFirst(5))
            Task { await store.selectTask(taskID, preservePinScope: false) }
        } else if id == "command:new-task" {
            store.selectSection(store.selectedProject?.raw["kind"].string == "casual" ? "chats" : "project")
            store.newTask(focusComposer: true)
        } else if id == "command:new-chat" {
            Task { await store.newChat() }
        } else if id == "command:open-project" {
            let panel = NSOpenPanel()
            panel.title = "Open project"; panel.prompt = "Open project"
            panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
            if panel.runModal() == .OK, let url = panel.url { Task { await store.openProject(path: url.path) } }
        } else if id == "command:reconnect" {
            Task { await store.reconnect() }
        } else if id.hasPrefix("command:") {
            store.selectSection(String(id.dropFirst(8)))
        }
    }

    private func searchMessages() async {
        let current = normalized
        let identity = UUID()
        searchIdentity = identity
        messageMatches = []; searchError = nil; searchNotice = nil; indexing = false
        let sources = searchSources
        guard current.count >= 2 else { searching = false; return }
        guard !sources.isEmpty else {
            searching = false; searchNotice = "Connect a computer to search message content."
            return
        }
        searching = true
        do {
            try await Task.sleep(for: .milliseconds(250))
            let results = await withTaskGroup(of: NativeMessageSearchResult.self) { group in
                for (order, source) in sources.enumerated() {
                    group.addTask { [store] in
                        do {
                            try Task.checkCancellation()
                            let result = try await store.request(path: "/api/threads/search", method: "POST", body: .object([
                                "query": .string(current), "workspace_id": .null, "limit": .number(30)
                            ]), hostID: source.hostID)
                            try Task.checkCancellation()
                            return NativeMessageSearchResult(order: order, source: source.name, value: result, error: nil)
                        } catch {
                            return NativeMessageSearchResult(order: order, source: source.name, value: nil, error: error.localizedDescription)
                        }
                    }
                }
                var results: [NativeMessageSearchResult] = []
                for await result in group { results.append(result) }
                return results.sorted { $0.order < $1.order }
            }
            try Task.checkCancellation()
            guard normalized == current, searchIdentity == identity else { return }
            let successful = results.compactMap(\.value)
            let failures = results.filter { $0.error != nil }
            messageMatches = NativeMessageSearchMerge.matches(successful)
            indexing = successful.contains { $0["indexing"].bool }
            if successful.isEmpty, let failure = failures.first {
                searchError = "Message search on \(failure.source): \(failure.error ?? "unavailable")"
            } else if !failures.isEmpty {
                searchNotice = "Some computers could not be searched: " + failures.map(\.source).joined(separator: ", ") + "."
            }
            searching = false
        } catch is CancellationError {
            // The next query owns the loading state and results.
        } catch {
            guard normalized == current, searchIdentity == identity else { return }
            searchError = "Message search: \(error.localizedDescription)"; searching = false
        }
    }

}

private struct NativeMessageSearchSource: Sendable {
    let hostID: String?
    let name: String
}

private struct NativeMessageSearchResult: Sendable {
    let order: Int
    let source: String
    let value: JSON?
    let error: String?
}

/// Each daemon ranks its own matches. Interleave those lists so the global cap
/// cannot discard every remote result behind a busy local computer.
enum NativeMessageSearchMerge {
    static func matches(_ responses: [JSON], limit: Int = 30) -> [JSON] {
        guard limit > 0 else { return [] }
        let lists = responses.map { $0["matches"].array }
        var matches: [JSON] = []
        var included: Set<String> = []
        for position in 0..<(lists.map(\.count).max() ?? 0) {
            for list in lists where position < list.count {
                let match = list[position], id = match["thread_id"].string
                guard !id.isEmpty, included.insert(id).inserted else { continue }
                matches.append(match)
                if matches.count == limit { return matches }
            }
        }
        return matches
    }
}

private struct SearchCommand: Identifiable {
    let id: String
    let name: String
    let symbol: String
    static let all = [
        SearchCommand(id: "new-task", name: "New task", symbol: "square.and.pencil"),
        SearchCommand(id: "new-chat", name: "New chat", symbol: "bubble.left.and.bubble.right"),
        SearchCommand(id: "open-project", name: "Open project…", symbol: "folder.badge.plus"),
        SearchCommand(id: "activity", name: "Show Activity", symbol: "tray"),
        SearchCommand(id: "automations", name: "Show Automations", symbol: "clock"),
        SearchCommand(id: "usage", name: "Show Usage", symbol: "chart.bar"),
        SearchCommand(id: "plugins", name: "Show Plugins and Skills", symbol: "puzzlepiece.extension"),
        SearchCommand(id: "extensions", name: "Show Extensions", symbol: "square.stack.3d.up"),
        SearchCommand(id: "settings", name: "Open Settings", symbol: "gearshape"),
        SearchCommand(id: "reconnect", name: "Reconnect to daemon", symbol: "arrow.clockwise")
    ]
}
