import AppKit
import Observation
import SwiftUI

extension Notification.Name {
    static let nativeInspectorOpenPath = Notification.Name("FalconDeck.nativeInspectorOpenPath")
}

struct NativeInspectorPathRequest: Equatable {
    let id = UUID()
    let workspaceID: String
    let threadID: String?
    let path: String
    let line: Int?
}

/// Retaining the pending route lets a transcript reveal the inspector and open
/// a file in one action, including when the inspector has not mounted yet.
@MainActor @Observable final class NativeInspectorNavigation {
    static let shared = NativeInspectorNavigation()
    var pending: NativeInspectorPathRequest?
    static func open(store: AppStore, path: String, line: Int? = nil) {
        guard let workspaceID = store.selectedProject?.id else { return }
        let route = NativeInspectorPathRequest(workspaceID: workspaceID, threadID: store.selectedTask?.id, path: path, line: line)
        shared.pending = route
        store.showInspector = true
        NotificationCenter.default.post(name: .nativeInspectorOpenPath, object: route)
    }
}

enum InspectorTab: String, CaseIterable, Identifiable {
    case info, changes, files
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var symbol: String {
        switch self { case .info: "info.circle"; case .changes: "arrow.triangle.branch"; case .files: "folder" }
    }
}

struct InspectorChange: Identifiable, Equatable {
    let path: String
    let status: String
    let insertions: Int
    let deletions: Int
    var id: String { path }
    init(_ raw: JSON) {
        path = raw["path"].string; status = raw["status"].string
        insertions = raw["insertions"].int; deletions = raw["deletions"].int
    }
    var mark: String {
        switch status { case "added": "A"; case "deleted": "D"; case "renamed": "R"; case "untracked": "?"; case "copied": "C"; default: "M" }
    }
    @MainActor var color: Color { status == "deleted" ? FDTheme.danger : ["added", "untracked"].contains(status) ? FDTheme.accent : FDTheme.warning }
}

struct InspectorTreeRow: Identifiable, Equatable {
    let path: String
    let directory: Bool
    let depth: Int
    var id: String { path }
    var name: String { path.split(separator: "/").last.map(String.init) ?? path }
}

/// Paths come from the daemon's bounded workspace index; this never walks the
/// Mac's filesystem or makes a remote workspace look like a local directory.
enum InspectorFileTree {
    static func rows(paths: [String], expanded: Set<String>, search: Bool = false) -> [InspectorTreeRow] {
        var directories = Set<String>()
        let files = Set(paths.filter { !$0.isEmpty })
        for path in files {
            let parts = path.split(separator: "/").map(String.init)
            guard parts.count > 1 else { continue }
            for length in 1..<parts.count { directories.insert(parts.prefix(length).joined(separator: "/")) }
        }
        var children: [String: [InspectorTreeRow]] = [:]
        for path in directories.union(files) {
            let parts = path.split(separator: "/").map(String.init)
            let parent = parts.dropLast().joined(separator: "/")
            children[parent, default: []].append(InspectorTreeRow(path: path, directory: directories.contains(path), depth: max(0, parts.count - 1)))
        }
        for parent in Array(children.keys) {
            children[parent]?.sort {
                if $0.directory != $1.directory { return $0.directory }
                return $0.name.localizedStandardCompare($1.name) == .orderedAscending
            }
        }
        var result: [InspectorTreeRow] = []
        func visit(_ parent: String) {
            for row in children[parent, default: []] {
                result.append(row)
                if row.directory && (search || expanded.contains(row.path)) { visit(row.path) }
            }
        }
        visit("")
        return result
    }
}

struct InspectorDocument {
    var raw: JSON
    var text: String
    var original: String
    var editing = false
    var dirty: Bool { text != original }
    var hasText: Bool { if case .string = raw["content"] { true } else { false } }
    var editable: Bool { hasText && !raw["truncated"].bool && !raw["version"].string.isEmpty }
    init(_ raw: JSON) { self.raw = raw; text = raw["content"].string; original = text }
}

@MainActor @Observable final class NativeInspectorModel {
    var scope = ""
    var projectID: String?
    var threadID: String?
    var branch = ""
    var changes: [InspectorChange] = []
    var paths: [String] = []
    var treeRows: [InspectorTreeRow] = []
    var expanded = Set<String>()
    var query = ""
    var truncated = false
    var selectedPath: String?
    var targetLine: Int?
    var file: InspectorDocument?
    var diff = ""
    var diffFallback = ""
    var loading = false
    var loadingFile = false
    private var savingKeys: Set<String> = []
    var reviewing = false
    var gitError: String?
    var filesError: String?
    var fileError: String?
    var notice: String?
    @ObservationIgnored private var filesRequest = UUID()
    @ObservationIgnored private var fileRequest = UUID()
    @ObservationIgnored private var gitRequest = UUID()
    @ObservationIgnored private var drafts: [String: InspectorDocument] = [:]
    @ObservationIgnored private var selections: [String: String] = [:]
    @ObservationIgnored private var expansions: [String: Set<String>] = [:]

    var insertions: Int { changes.reduce(0) { $0 + $1.insertions } }
    var deletions: Int { changes.reduce(0) { $0 + $1.deletions } }
    var selectedChange: InspectorChange? { changes.first { $0.path == selectedPath } }
    var filteredChanges: [InspectorChange] { query.isEmpty ? changes : changes.filter { $0.path.localizedCaseInsensitiveContains(query) } }
    var documentKey: String { "\(scope):\(selectedPath ?? "")" }
    var saving: Bool { savingKeys.contains(documentKey) }

    func changeScope(store: AppStore) async {
        rememberDocument()
        selections[scope] = selectedPath
        expansions[scope] = expanded
        projectID = store.selectedProject?.id
        threadID = store.selectedTask?.id
        scope = "\(projectID ?? ""):\(threadID ?? "")"
        filesRequest = UUID(); fileRequest = UUID(); gitRequest = UUID()
        selectedPath = selections[scope]; expanded = expansions[scope, default: []]
        file = nil; targetLine = nil; diff = ""; diffFallback = ""; changes = []; branch = ""; paths = []; treeRows = []
        query = ""; filesError = nil; fileError = nil; gitError = nil; notice = nil
        loadingFile = false
        guard projectID != nil else { return }
        await refreshGit(store: store)
    }

    private var threadQuery: [URLQueryItem] { threadID.map { [URLQueryItem(name: "thread_id", value: $0)] } ?? [] }

    func refreshGit(store: AppStore) async {
        guard let projectID, store.selectedProject?.raw["kind"].string != "casual" else { return }
        let request = UUID(); gitRequest = request; loading = true
        do {
            let response = try await store.request(["api", "workspaces", projectID, "git", "status"], query: threadQuery)
            guard gitRequest == request else { return }
            branch = response["branch"].string; changes = response["entries"].array.map(InspectorChange.init); gitError = nil
        } catch {
            guard gitRequest == request else { return }
            gitError = error.localizedDescription
        }
        if gitRequest == request { loading = false }
    }

    func refreshFiles(store: AppStore) async {
        guard let projectID else { return }
        let request = UUID(); filesRequest = request; loading = true
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        var parameters = threadQuery
        if !search.isEmpty { parameters.append(URLQueryItem(name: "query", value: search)) }
        do {
            let response = try await store.request(["api", "workspaces", projectID, "files"], query: parameters)
            guard filesRequest == request else { return }
            paths = response["files"].array.map(\.string); truncated = response["truncated"].bool
            treeRows = InspectorFileTree.rows(paths: paths, expanded: expanded, search: !search.isEmpty)
            filesError = nil
        } catch {
            guard filesRequest == request else { return }
            filesError = error.localizedDescription
        }
        if filesRequest == request { loading = false }
    }

    func toggle(_ row: InspectorTreeRow) {
        if expanded.contains(row.path) { expanded.remove(row.path) } else { expanded.insert(row.path) }
        treeRows = InspectorFileTree.rows(paths: paths, expanded: expanded, search: !query.isEmpty)
    }

    func select(path: String, store: AppStore, tab: InspectorTab, line: Int? = nil) async {
        rememberDocument(); selectedPath = path
        targetLine = line
        file = drafts[documentKey]; diff = ""; diffFallback = ""; fileError = nil
        await loadSelection(store: store, tab: tab)
    }

    func loadSelection(store: AppStore, tab: InspectorTab, discardDraft: Bool = false) async {
        guard let projectID, let path = selectedPath else { return }
        let request = UUID(); fileRequest = request; loadingFile = true; fileError = nil
        var parameters = threadQuery + [URLQueryItem(name: "path", value: path)]
        if tab == .changes, let status = selectedChange?.status { parameters.append(URLQueryItem(name: "status", value: status)) }
        do {
            if tab == .changes {
                let result = try await store.request(["api", "workspaces", projectID, "git", "diff"], query: parameters)
                guard fileRequest == request else { return }
                diff = result["diff"].string; diffFallback = result["content"].string
            }
            if selectedChange?.status != "deleted" || tab == .files {
                // A cached dirty document retains the version it was opened
                // with. Reload is explicit, so a refresh cannot erase edits.
                if file?.dirty != true || discardDraft {
                    let textAtRequest = file?.text
                    let result = try await store.request(["api", "workspaces", projectID, "files", "content"], query: threadQuery + [URLQueryItem(name: "path", value: path)])
                    guard fileRequest == request else { return }
                    // Typing can begin while a refresh is in flight. An
                    // explicit discard applies to the text at the click,
                    // never to later keystrokes.
                    if file?.dirty != true || (discardDraft && file?.text == textAtRequest) {
                        var refreshed = InspectorDocument(result)
                        refreshed.editing = file?.editing ?? false
                        file = refreshed
                        drafts.removeValue(forKey: documentKey)
                    }
                }
            }
        } catch {
            guard fileRequest == request else { return }
            fileError = error.localizedDescription
        }
        if fileRequest == request { loadingFile = false }
    }

    func rememberDocument() {
        guard selectedPath != nil else { return }
        if let file, file.dirty { drafts[documentKey] = file }
        else { drafts.removeValue(forKey: documentKey) }
    }

    func save(store: AppStore) async {
        guard let projectID, let path = selectedPath, let document = file, document.editable, !saving else { return }
        let key = documentKey; savingKeys.insert(key); fileError = nil
        defer { savingKeys.remove(key) }
        let requestScope = scope
        do {
            let result = try await store.request(["api", "workspaces", projectID, "files", "content"], method: "PUT", query: threadQuery + [URLQueryItem(name: "path", value: path)], body: .object([
                "content": .string(document.text), "expected_version": document.raw["version"]
            ]))
            var saved = InspectorDocument(result)
            saved.editing = true
            // Keystrokes typed while the PUT was in flight remain unsaved.
            let current = requestScope == scope && selectedPath == path ? file : drafts[key]
            if let current, current.text != document.text { saved.text = current.text }
            if saved.dirty { drafts[key] = saved } else { drafts.removeValue(forKey: key) }
            guard requestScope == scope, selectedPath == path else { return }
            file = saved; notice = "Saved \(URL(fileURLWithPath: path).lastPathComponent)"
            await refreshGit(store: store)
        } catch {
            guard requestScope == scope, selectedPath == path else { return }
            fileError = error.localizedDescription
        }
    }

    func review(store: AppStore) async {
        guard let projectID, let threadID, !reviewing else { return }
        let reviewScope = scope
        reviewing = true; notice = nil
        do {
            _ = try await store.request(["api", "workspaces", projectID, "threads", threadID, "review"], method: "POST", body: .object(["target": .object(["type": .string("uncommittedChanges")])]))
            guard reviewScope == scope else { reviewing = false; return }
            notice = "Review started in this task."
        } catch { if reviewScope == scope { notice = error.localizedDescription } }
        reviewing = false
    }

    func adjacent(_ direction: Int, store: AppStore) async {
        let entries = filteredChanges
        guard !entries.isEmpty else { return }
        let index = entries.firstIndex { $0.path == selectedPath } ?? (direction > 0 ? -1 : 0)
        let next = (index + direction + entries.count) % entries.count
        await select(path: entries[next].path, store: store, tab: .changes)
    }
}

struct NativeInspectorView: View {
    let store: AppStore
    @State private var model = NativeInspectorModel()
    @AppStorage("native.inspector.tab") private var tabValue = InspectorTab.info.rawValue
    @State private var preview = true
    @State private var discardAlert = false
    @State private var consumedRoute: UUID?
    private var tab: InspectorTab { InspectorTab(rawValue: tabValue) ?? .info }
    private var scope: String { "\(store.selectedProject?.id ?? ""):\(store.selectedTask?.id ?? "")" }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if store.selectedProject == nil {
                NativeEmptyState(symbol: "sidebar.right", title: "Project inspector", detail: "Select a project to browse its files and changes.")
            } else if tab == .info {
                info
            } else {
                browser
            }
        }
        .background(FDTheme.surface)
        .foregroundStyle(FDTheme.foreground)
        .task(id: scope) {
            await model.changeScope(store: store)
            if tab == .files { await model.refreshFiles(store: store) }
            if model.selectedPath != nil { await model.loadSelection(store: store, tab: tab) }
            await consumeRoute()
        }
        .task(id: "\(scope):\(tab.rawValue):\(model.query)") {
            if !model.query.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled, model.scope == scope else { return }
            if tab == .files { await model.refreshFiles(store: store) }
        }
        .task(id: "\(scope):refresh") {
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                guard !Task.isCancelled else { return }
                if store.isConnected { await model.refreshGit(store: store) }
            }
        }
        .onChange(of: tabValue) { _, _ in
            model.query = ""
            Task {
                if tab == .files { await model.refreshFiles(store: store) }
                if model.selectedPath != nil { await model.loadSelection(store: store, tab: tab) }
            }
        }
        .onChange(of: NativeInspectorNavigation.shared.pending?.id) { _, _ in Task { await consumeRoute() } }
        .onReceive(NotificationCenter.default.publisher(for: .nativeInspectorOpenPath)) { notification in
            if let route = notification.object as? NativeInspectorPathRequest { NativeInspectorNavigation.shared.pending = route }
            else if let info = notification.userInfo, let path = info["path"] as? String,
                    let workspaceID = info["workspace_id"] as? String {
                NativeInspectorNavigation.shared.pending = NativeInspectorPathRequest(workspaceID: workspaceID, threadID: info["thread_id"] as? String, path: path, line: info["line"] as? Int)
            }
            Task { await consumeRoute() }
        }
        .onDisappear { model.rememberDocument() }
        .alert("Discard unsaved changes?", isPresented: $discardAlert) {
            Button("Reload from disk", role: .destructive) { Task { await model.loadSelection(store: store, tab: tab, discardDraft: true) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The current edits will be replaced with the file on disk.") }
    }

    private var header: some View {
        HStack(spacing: 4) {
            ForEach(InspectorTab.allCases) { item in
                Button { tabValue = item.rawValue } label: {
                    Label(item.title, systemImage: item.symbol).font(NativePreferences.shared.font(size: 13, weight: .medium))
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(tab == item ? FDTheme.raised : .clear, in: .rect(cornerRadius: 6))
                }.buttonStyle(.plain).foregroundStyle(tab == item ? FDTheme.foreground : FDTheme.muted)
            }
            Spacer(minLength: 0)
            if model.loading { MacActivityDiamond() }
            Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(NativeIconButtonStyle()).help("Refresh inspector")
        }.padding(8).frame(height: 46)
    }

    private var info: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 10) {
                    infoRow("Environment", symbol: isRemote ? "globe" : "laptopcomputer", value: store.selectedProject?.raw["host_name"].string.nonEmpty ?? (isRemote ? "Remote server" : "This Mac"))
                    infoRow("Works in", symbol: "folder", value: workingKind)
                    infoRow("Directory", symbol: "folder.badge.gearshape", value: localRoot, copy: true)
                    if !model.branch.isEmpty { infoRow("Branch", symbol: "arrow.triangle.branch", value: model.branch, copy: true) }
                    if let task = store.selectedTask {
                        infoRow("Agent", symbol: "sparkles", value: FDTheme.providerName(task.provider))
                        if !task.modelID.isEmpty { infoRow("Model", symbol: "cpu", value: task.modelID) }
                        infoRow("Status", symbol: "circle.dotted", value: FDTheme.statusLabel(task.status))
                        infoRow("Task ID", symbol: "number", value: task.id, copy: true)
                    }
                }
                if !localRoot.isEmpty && !isRemote {
                    Button { NSWorkspace.shared.open(URL(fileURLWithPath: localRoot, isDirectory: true)) } label: { Label("Open folder in Finder", systemImage: "arrow.up.forward.app") }
                        .controlSize(.small)
                }
                Divider()
                if let error = model.gitError { errorView(error) }
                else if model.changes.isEmpty {
                    Label(store.selectedProject?.raw["kind"].string == "casual" ? "Chat documents are in Files." : "Working tree clean", systemImage: "checkmark.circle")
                        .font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted)
                } else {
                    HStack { Text("UNCOMMITTED").font(NativePreferences.shared.font(size: 11, weight: .semibold)); Spacer(); changeTotals }
                        .foregroundStyle(FDTheme.muted)
                    VStack(spacing: 2) {
                        ForEach(model.changes.prefix(8)) { change in changeRow(change) }
                    }
                    Button("View all \(model.changes.count) changes") { tabValue = InspectorTab.changes.rawValue }.controlSize(.small)
                }
                if let notice = model.notice { Text(notice).font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted).textSelection(.enabled) }
            }.padding(16)
        }
    }

    private var browser: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(FDTheme.muted)
                TextField(tab == .files ? "Search project files" : "Filter changes", text: $model.query).textFieldStyle(.plain)
                if !model.query.isEmpty { Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(FDTheme.muted) }
            }.font(NativePreferences.shared.font(size: 13)).padding(10)
            if tab == .changes {
                HStack {
                    Text(model.branch.isEmpty ? "Working tree" : model.branch).lineLimit(1)
                    Spacer()
                    changeTotals
                    Button(model.reviewing ? "Reviewing…" : "Review") { Task { await model.review(store: store) } }
                        .controlSize(.small).disabled(model.reviewing || store.selectedTask == nil || model.changes.isEmpty || store.selectedTask?.provider != "codex")
                        .help("Review uncommitted changes with Codex in this task")
                }.font(NativePreferences.shared.font(size: 11)).foregroundStyle(FDTheme.muted).padding(.horizontal, 10).padding(.bottom, 8)
            }
            Divider()
            VSplitView {
                fileList.frame(minHeight: 100, idealHeight: 190, maxHeight: model.selectedPath == nil ? .infinity : 300)
                if model.selectedPath != nil { fileViewer.frame(minHeight: 140, maxHeight: .infinity) }
            }
            if let notice = model.notice {
                Divider()
                HStack { Text(notice).font(NativePreferences.shared.font(size: 13)).textSelection(.enabled); Spacer(); Button { model.notice = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain) }
                    .foregroundStyle(FDTheme.muted).padding(8)
            }
        }
    }

    private var fileList: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if let error = tab == .files ? model.filesError : model.gitError { errorView(error).padding(12) }
                if tab == .files {
                    ForEach(model.treeRows) { row in
                        Button {
                            if row.directory { model.toggle(row) }
                            else { Task { await model.select(path: row.path, store: store, tab: .files) } }
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: row.directory ? (model.expanded.contains(row.path) || !model.query.isEmpty ? "chevron.down" : "chevron.right") : "").font(.system(size: 8)).frame(width: 8)
                                Image(systemName: row.directory ? "folder.fill" : Self.fileSymbol(row.path)).foregroundStyle(row.directory ? FDTheme.info : FDTheme.muted).frame(width: 15)
                                Text(row.name).lineLimit(1)
                                Spacer(minLength: 0)
                                if let change = model.changes.first(where: { $0.path == row.path }) { Text(change.mark).font(NativePreferences.shared.font(size: 11, surface: "code", weight: .medium)).foregroundStyle(change.color) }
                            }.font(NativePreferences.shared.font(size: 13)).padding(.leading, CGFloat(8 + row.depth * 12)).padding(.trailing, 10).frame(height: 27)
                                .background(model.selectedPath == row.path ? FDTheme.accentDim : Color.clear).contentShape(.rect)
                        }.buttonStyle(.plain).contextMenu { pathActions(row.path) }.help(row.path)
                    }
                    if model.truncated { Text(model.query.isEmpty ? "Showing the first 20,000 paths. Search to find other files." : "Showing the first 500 matches. Refine the search for more.").font(NativePreferences.shared.font(size: 11)).foregroundStyle(FDTheme.warning).padding(12) }
                    if model.treeRows.isEmpty && !model.loading && model.filesError == nil { listEmpty("No matching files", symbol: "doc.text.magnifyingglass") }
                } else {
                    ForEach(model.filteredChanges) { change in changeRow(change) }
                    if model.filteredChanges.isEmpty && !model.loading && model.gitError == nil { listEmpty(model.query.isEmpty ? "No uncommitted changes" : "No matching changes", symbol: "checkmark.circle") }
                }
            }.padding(.vertical, 5)
        }.background(FDTheme.background.opacity(0.35))
    }

    private var fileViewer: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: Self.fileSymbol(model.selectedPath ?? ""))
                Text(URL(fileURLWithPath: model.selectedPath ?? "").lastPathComponent).fontWeight(.medium).lineLimit(1)
                if model.file?.dirty == true { Circle().fill(FDTheme.warning).frame(width: 5, height: 5).help("Unsaved changes") }
                Spacer(minLength: 0)
                if tab == .changes {
                    Button { Task { await model.adjacent(-1, store: store) } } label: { Image(systemName: "chevron.up") }.buttonStyle(NativeIconButtonStyle()).help("Previous changed file")
                    Button { Task { await model.adjacent(1, store: store) } } label: { Image(systemName: "chevron.down") }.buttonStyle(NativeIconButtonStyle()).help("Next changed file")
                }
                if model.file?.editable == true {
                    if model.file?.editing == true {
                        Button(model.saving ? "Saving…" : "Save") { Task { await model.save(store: store) } }
                            .keyboardShortcut("s", modifiers: .command).controlSize(.small).disabled(model.saving || model.file?.dirty != true)
                    } else {
                        Button { model.file?.editing = true } label: { Image(systemName: "pencil") }.buttonStyle(NativeIconButtonStyle()).help("Edit file")
                    }
                }
                Menu {
                    if let path = model.selectedPath { pathActions(path) }
                    if model.file?.hasText == true { Button("Copy contents") { FDTheme.copy(model.file?.text ?? "") } }
                    if model.file?.editing == true { Button("Read only") { model.file?.editing = false } }
                    if isMarkdown || model.file?.raw["mime_type"].string == "image/svg+xml" { Button(preview ? "Show source" : "Show preview") { preview.toggle() } }
                    Button("Reload from disk") {
                        if model.file?.dirty == true { discardAlert = true }
                        else { Task { await model.loadSelection(store: store, tab: tab, discardDraft: true) } }
                    }
                    Button("Close file") { model.rememberDocument(); model.selectedPath = nil; model.file = nil }
                } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().frame(width: 22)
            }.font(NativePreferences.shared.font(size: 11)).padding(.leading, 10).padding(.trailing, 6).frame(height: 34)
            Divider()
            if let error = model.fileError {
                VStack(alignment: .leading, spacing: 6) {
                    errorView(error)
                    if model.file?.dirty == true { Text("Your edits are kept. Reload only when you are ready to discard them.").font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted) }
                }.padding(10)
                Divider()
            }
            if model.loadingFile && model.file == nil && model.diff.isEmpty {
                VStack { MacActivityDiamond(); Text("Loading file…").font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted) }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                previewBody
            }
            if let file = model.file {
                Divider()
                HStack {
                    Text(model.selectedPath ?? "").lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    if let size = file.raw["size_bytes"].optionalInt { Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)) }
                    if file.hasText { Text("\(file.text.components(separatedBy: "\n").count) lines") }
                }.font(NativePreferences.shared.font(size: 11, surface: "code")).foregroundStyle(FDTheme.muted).padding(.horizontal, 8).frame(height: 24)
            }
        }.background(FDTheme.background)
    }

    @ViewBuilder private var previewBody: some View {
        if let file = model.file, file.editing {
            InspectorCodeEditor(text: Binding(get: { model.file?.text ?? "" }, set: { model.file?.text = $0 }), editable: true, language: model.selectedPath ?? "", line: model.targetLine)
        } else if tab == .changes && !model.diff.isEmpty {
            InspectorCodeEditor(text: .constant(model.diff), editable: false, language: "diff", diff: true)
        } else if let file = model.file {
            if file.raw["truncated"].bool {
                listEmpty("File exceeds the built-in preview limit", symbol: "doc.badge.ellipsis").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if isMarkdown && preview && file.hasText {
                InspectorMarkdownPreview(text: file.text)
            } else if preview && !file.raw["mime_type"].string.isEmpty {
                InspectorMediaPreview(file: file.raw)
            } else if file.hasText {
                InspectorCodeEditor(text: .constant(file.text), editable: false, language: model.selectedPath ?? "", line: model.targetLine)
            } else {
                listEmpty("Binary file", symbol: "doc.zipper").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else if !model.diffFallback.isEmpty {
            InspectorCodeEditor(text: .constant(model.diffFallback), editable: false, language: model.selectedPath ?? "")
        } else {
            listEmpty("No preview available", symbol: "doc").frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var changeTotals: some View {
        HStack(spacing: 6) {
            Text("\(model.changes.count) files").foregroundStyle(FDTheme.muted)
            Text("+\(model.insertions)").foregroundStyle(FDTheme.accent)
            Text("−\(model.deletions)").foregroundStyle(FDTheme.danger)
        }.font(NativePreferences.shared.font(size: 11, surface: "code"))
    }

    private func changeRow(_ change: InspectorChange) -> some View {
        Button {
            tabValue = InspectorTab.changes.rawValue
            Task { await model.select(path: change.path, store: store, tab: .changes) }
        } label: {
            HStack(spacing: 7) {
                Text(change.mark).font(NativePreferences.shared.font(size: 11, surface: "code", weight: .medium)).foregroundStyle(change.color).frame(width: 12)
                Image(systemName: Self.fileSymbol(change.path)).foregroundStyle(FDTheme.muted).frame(width: 14)
                Text(change.path).lineLimit(1).truncationMode(.middle).foregroundStyle(FDTheme.secondary)
                Spacer(minLength: 3)
                if change.insertions > 0 { Text("+\(change.insertions)").foregroundStyle(FDTheme.accent) }
                if change.deletions > 0 { Text("−\(change.deletions)").foregroundStyle(FDTheme.danger) }
            }.font(NativePreferences.shared.font(size: 13)).padding(.horizontal, 9).frame(height: 28)
                .background(model.selectedPath == change.path ? FDTheme.accentDim : Color.clear).contentShape(.rect)
        }.buttonStyle(.plain).contextMenu { pathActions(change.path) }.help(change.path)
    }

    private func infoRow(_ title: String, symbol: String, value: String, copy: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Label(title, systemImage: symbol).foregroundStyle(FDTheme.muted).frame(width: 94, alignment: .leading)
            Text(value.isEmpty ? "—" : value).foregroundStyle(FDTheme.secondary).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
            Spacer(minLength: 0)
            if copy && !value.isEmpty { Button { FDTheme.copy(value) } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.plain).help("Copy \(title.lowercased())") }
        }.font(NativePreferences.shared.font(size: 13))
    }

    @ViewBuilder private func pathActions(_ path: String) -> some View {
        Button("Copy relative path") { FDTheme.copy(path) }
        if let localURL = localFileURL(path) {
            Button("Copy full path") { FDTheme.copy(localURL.path) }
            Button("Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([localURL]) }
            Button("Open in default app") { NSWorkspace.shared.open(localURL) }
        }
        if tab != .files { Button("Show in Files") { tabValue = InspectorTab.files.rawValue; Task { await model.select(path: path, store: store, tab: .files) } } }
    }

    private func errorView(_ error: String) -> some View {
        Label(error, systemImage: "exclamationmark.triangle").font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.warning).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func listEmpty(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol).font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted).padding(20).frame(maxWidth: .infinity)
    }
    private var localRoot: String { store.selectedTask?.raw["variant"]["path"].string.nonEmpty ?? store.selectedProject?.path ?? "" }
    private var workingKind: String {
        if let variant = store.selectedTask?.raw["variant"], !variant["path"].string.isEmpty { return "Isolated \(variant["kind"].string)" }
        return store.selectedProject?.raw["kind"].string == "casual" ? "Chat folder" : "Project folder"
    }
    private var isRemote: Bool { store.selectedHostID != nil }
    private var isMarkdown: Bool { ["md", "mdx", "markdown"].contains(URL(fileURLWithPath: model.selectedPath ?? "").pathExtension.lowercased()) }
    private func localFileURL(_ path: String) -> URL? {
        guard !isRemote, !localRoot.isEmpty else { return nil }
        let root = URL(fileURLWithPath: localRoot, isDirectory: true).resolvingSymlinksInPath()
        let candidate = (path.hasPrefix("/") ? URL(fileURLWithPath: path) : root.appendingPathComponent(path)).resolvingSymlinksInPath()
        return candidate.path.hasPrefix(root.path + "/") ? candidate : nil
    }
    private func refresh() async {
        await model.refreshGit(store: store)
        if tab == .files { await model.refreshFiles(store: store) }
        if model.selectedPath != nil { await model.loadSelection(store: store, tab: tab) }
    }
    private func consumeRoute() async {
        guard let route = NativeInspectorNavigation.shared.pending, route.id != consumedRoute,
              route.workspaceID == store.selectedProject?.id,
              route.threadID == nil || route.threadID == store.selectedTask?.id,
              model.scope == scope else { return }
        consumedRoute = route.id
        tabValue = InspectorTab.files.rawValue
        var path = route.path
        if !localRoot.isEmpty, path.hasPrefix(localRoot + "/") { path = String(path.dropFirst(localRoot.count + 1)) }
        let components = path.split(separator: "/").map(String.init)
        if components.count > 1 {
            for count in 1..<components.count { model.expanded.insert(components.prefix(count).joined(separator: "/")) }
        }
        if route.line != nil { preview = false }
        await model.refreshFiles(store: store)
        await model.select(path: path, store: store, tab: .files, line: route.line)
        if NativeInspectorNavigation.shared.pending?.id == route.id { NativeInspectorNavigation.shared.pending = nil }
    }
    static func fileSymbol(_ path: String) -> String {
        switch URL(fileURLWithPath: path).pathExtension.lowercased() {
        case "swift": "swift"
        case "rs", "js", "ts", "tsx", "jsx", "py", "rb", "go", "c", "h", "cpp", "m", "sh": "chevron.left.forwardslash.chevron.right"
        case "md", "mdx", "txt", "markdown": "doc.text"
        case "json", "yaml", "yml", "toml", "xml", "plist": "curlybraces"
        case "png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "avif": "photo"
        case "pdf": "doc.richtext"
        case "mp4", "mov", "webm": "film"
        case "mp3", "wav", "m4a", "ogg": "waveform"
        default: "doc"
        }
    }
}

private extension String { var nonEmpty: String? { isEmpty ? nil : self } }
