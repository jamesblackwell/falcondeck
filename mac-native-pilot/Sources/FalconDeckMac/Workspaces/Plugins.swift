import AppKit
import SwiftUI

/// The same daemon-owned connector catalog and shared skill library as desktop.
struct NativePluginsView: View {
    let store: AppStore
    @State private var tab = "plugins"
    @State private var query = ""
    @State private var catalog: [JSON] = []
    @State private var library: JSON = .null
    @State private var registry: [JSON] = []
    @State private var connectors: JSON = .null
    @State private var scope = "global"
    @State private var loadedScope: String?
    @State private var source = ""
    @State private var busy: String?
    @State private var loading = false
    @State private var searching = false
    @State private var error: String?
    @State private var registryError: String?
    @State private var notice: String?
    @State private var keyServer: JSON?
    @State private var editor: NativePluginConnectorDraft?
    @State private var importing = false
    @State private var removal: NativePluginRemoval?
    @State private var oauthTask: Task<Void, Never>?
    @State private var loadID = UUID()
    @State private var connectorLoadID = UUID()
    @State private var catalogLoadID = UUID()

    private var projects: [Project] {
        store.projects.filter { $0.raw["kind"].string != "casual" }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(FDTheme.hairline)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    searchBar
                    if let error { feedback(error, isError: true) }
                    if let notice { feedback(notice, isError: false) }
                    if loading { ProgressView().controlSize(.small).frame(maxWidth: .infinity) }
                    switch tab {
                    case "skills": skillsContent
                    case "servers": connectorContent
                    default: catalogContent
                    }
                }
                .frame(maxWidth: 1040, alignment: .leading)
                .padding(28)
                .frame(maxWidth: .infinity)
            }
        }
        .background(FDTheme.background)
        .foregroundStyle(FDTheme.foreground)
        .task(id: tab) { await load() }
        .task(id: tab + ":" + query) {
            guard tab == "skills" else { return }
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            await searchSkills()
        }
        .task(id: scope) { await loadConnectors() }
        .onDisappear { oauthTask?.cancel(); oauthTask = nil }
        .sheet(isPresented: Binding(get: { keyServer != nil }, set: { if !$0 { keyServer = nil } })) {
            if let server = keyServer {
                NativePluginKeySheet(server: server, save: { key in
                    await installPlugin(server, apiKey: key)
                })
            }
        }
        .sheet(item: $editor) { draft in
            NativePluginConnectorSheet(draft: draft, onSave: { updated in
                await saveConnector(updated)
            })
        }
        .sheet(isPresented: $importing) {
            NativePluginImportSheet { entries in await importConnectors(entries) }
        }
        .confirmationDialog(removal?.title ?? "Remove", isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }), titleVisibility: .visible) {
            if let item = removal {
                Button("Remove", role: .destructive) {
                    removal = nil
                    Task { await remove(item) }
                }
            }
            Button("Cancel", role: .cancel) { removal = nil }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Image(systemName: "puzzlepiece.extension").foregroundStyle(FDTheme.accent)
            Text("Plugins").font(NativePreferences.shared.font(size: 18, weight: .semibold))
            Spacer()
            Picker("Browse", selection: $tab) {
                Text("Plugins").tag("plugins")
                Text("Skills").tag("skills")
                Text("MCP servers").tag("servers")
            }
            .pickerStyle(.segmented).frame(width: 300)
            Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(NativeIconButtonStyle()).help("Refresh plugins and skills")
                .disabled(loading || busy != nil)
        }
        .padding(.horizontal, 24).frame(height: 58)
    }

    private var searchBar: some View {
        HStack(spacing: 14) {
            Text(tab == "skills" ? "Extend your agents with task-specific skills." : "Connect your agents to the tools you use.")
                .font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted)
            Spacer(minLength: 20)
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").foregroundStyle(FDTheme.muted)
                TextField(tab == "skills" ? "Search skills" : "Search plugins", text: $query).textFieldStyle(.plain)
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(FDTheme.muted).help("Clear search")
                }
            }
            .padding(9).frame(width: 250).background(FDTheme.raised, in: .rect(cornerRadius: 8))
        }
    }

    private var catalogContent: some View {
        VStack(alignment: .leading, spacing: 24) {
            NativePluginSection(title: "Installed") {
                let installed = catalog.filter { $0["installed"].bool || $0["connected"].bool }
                let custom = object(connectors["global"]).keys.filter { name in !catalog.contains { $0["id"].string == name } }.sorted()
                if installed.isEmpty && custom.isEmpty {
                    empty("Nothing installed yet", detail: "Connect a plugin below, or add a custom MCP server.")
                } else {
                    ForEach(installed, id: \.self) { plugin in catalogRow(plugin) }
                    ForEach(custom, id: \.self) { name in
                        HStack(spacing: 12) {
                            pluginIcon(name, symbol: "terminal")
                            Text(name).fontWeight(.medium)
                            Spacer()
                            Text("Custom MCP server").foregroundStyle(FDTheme.muted).font(.caption)
                            Button("Manage") { tab = "servers" }
                        }.padding(12)
                    }
                }
            }
            let filtered = catalog.filter { matches($0, fields: ["name", "description", "category"]) }
            if !query.isEmpty && filtered.isEmpty && !loading {
                empty("No matching plugins", detail: "Try another name or category.")
            }
            let categories = ["Featured", "Productivity", "Developer tools", "Creativity", "Commerce"]
            ForEach(categories, id: \.self) { category in
                let entries = filtered.filter { category == "Featured" ? $0["featured"].bool : $0["category"].string == category && (!$0["featured"].bool || !query.isEmpty) }
                if !entries.isEmpty {
                    NativePluginSection(title: category) {
                        ForEach(entries, id: \.self) { plugin in catalogRow(plugin) }
                    }
                }
            }
            Button { tab = "servers"; editor = NativePluginConnectorDraft(scope: scope) } label: {
                Label("Add a custom MCP server", systemImage: "plus")
            }.disabled(busy != nil)
        }
    }

    private func catalogRow(_ plugin: JSON) -> some View {
        HStack(spacing: 13) {
            pluginIcon(plugin["name"].string)
            VStack(alignment: .leading, spacing: 4) {
                Text(plugin["name"].string).font(NativePreferences.shared.font(size: 13, weight: .semibold))
                Text(plugin["description"].string).font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted).lineLimit(2)
            }
            Spacer(minLength: 16)
            if plugin["connected"].bool {
                Label("Connected", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(FDTheme.accent)
            } else {
                Button(busy == plugin["id"].string ? "Waiting…" : plugin["auth"].string == "oauth" ? (plugin["installed"].bool ? "Reconnect" : "Connect") : "Install") {
                    if plugin["auth"].string == "api_key" { keyServer = plugin }
                    else {
                        oauthTask?.cancel()
                        oauthTask = Task { _ = await installPlugin(plugin) }
                    }
                }.disabled(busy != nil || loading)
            }
        }.padding(14)
    }

    private var skillsContent: some View {
        VStack(alignment: .leading, spacing: 24) {
            NativePluginSection(title: "Installed skills") {
                let sources = Array(Set(library["skills"].array.map { $0["source"].string.isEmpty ? "Personal" : $0["source"].string })).sorted()
                if sources.count > 1 {
                    Picker("Source", selection: $source) {
                        Text("All sources").tag("")
                        ForEach(sources, id: \.self) { Text($0).tag($0) }
                    }.padding(12).frame(maxWidth: 400)
                }
                let installed = library["skills"].array.filter {
                    matches($0, fields: ["name", "description", "source"]) && (source.isEmpty || ($0["source"].string.isEmpty ? "Personal" : $0["source"].string) == source)
                }
                if installed.isEmpty && !loading {
                    empty(query.isEmpty ? "No skills installed" : "No installed skills match", detail: "Skills installed here are shared with your agents.")
                }
                ForEach(installed, id: \.self) { skill in installedSkillRow(skill) }
            }
            if !library["root"].string.isEmpty {
                Button { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: library["root"].string) } label: {
                    Label(library["root"].string, systemImage: "folder")
                }.buttonStyle(.plain).font(.caption).foregroundStyle(FDTheme.muted)
            }
            NativePluginSection(title: query.trimmingCharacters(in: .whitespaces).count >= 2 ? "Search results" : "Trending on skills.sh") {
                HStack {
                    Text("From the open skills.sh directory. Install sources you trust.")
                        .font(.caption).foregroundStyle(FDTheme.muted)
                    Spacer()
                    if searching { ProgressView().controlSize(.small) }
                    Link("Browse directory", destination: URL(string: "https://skills.sh")!).font(.caption)
                }.padding(14)
                if let registryError { feedback(registryError, isError: true).padding(.horizontal, 14) }
                let available = registry.filter { !$0["installed"].bool }
                if available.isEmpty && !searching && registryError == nil {
                    empty("No skills to show", detail: "Search by skill name or topic.")
                }
                ForEach(available, id: \.self) { skill in
                    HStack(spacing: 12) {
                        pluginIcon(skill["skillId"].string, symbol: "sparkles")
                        VStack(alignment: .leading, spacing: 4) {
                            Text("/" + skill["skillId"].string).font(NativePreferences.shared.font(size: 13, weight: .semibold))
                            Text(skill["source"].string).font(.caption).foregroundStyle(FDTheme.muted)
                        }
                        Spacer()
                        Text(skill["installs"].int.formatted(.number.notation(.compactName)) + " installs")
                            .font(.caption).foregroundStyle(FDTheme.subtle)
                        Button(busy == skill["id"].string ? "Installing…" : "Install") {
                            Task { await installSkill(source: skill["source"].string, name: skill["skillId"].string, busyID: skill["id"].string) }
                        }.disabled(busy != nil || searching)
                    }.padding(14)
                }
            }
        }
    }

    private func installedSkillRow(_ skill: JSON) -> some View {
        HStack(alignment: .top, spacing: 12) {
            pluginIcon(skill["name"].string, symbol: "checkmark")
            VStack(alignment: .leading, spacing: 4) {
                Text("/" + skill["name"].string).font(NativePreferences.shared.font(size: 13, weight: .semibold))
                if !skill["description"].string.isEmpty {
                    Text(skill["description"].string).font(.caption).foregroundStyle(FDTheme.muted).lineLimit(3)
                }
                Text(skill["source"].string.isEmpty ? "Personal" : skill["source"].string).font(.caption2).foregroundStyle(FDTheme.subtle)
            }
            Spacer()
            Menu {
                if !skill["path"].string.isEmpty {
                    Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: skill["path"].string)]) }
                }
                if skill["managed"].bool {
                    if let url = URL(string: "https://github.com/" + skill["source"].string), !skill["source"].string.isEmpty {
                        Link("View source", destination: url)
                    }
                    Button("Remove skill", role: .destructive) {
                        removal = NativePluginRemoval(title: "Remove /\(skill["name"].string)?", skill: skill["name"].string)
                    }
                }
            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 24).disabled(busy != nil)
            if !skill["managed"].bool { Text("Hand-managed").font(.caption2).foregroundStyle(FDTheme.subtle) }
        }.padding(14)
    }

    private var connectorContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Picker("Configuration scope", selection: $scope) {
                    Text("Global — all projects").tag("global")
                    ForEach(projects) { Text($0.name).tag($0.id) }
                }.frame(maxWidth: 360).disabled(busy != nil)
                Spacer()
                Button("Paste JSON") { importing = true }.disabled(!connectorReady)
                Button { editor = NativePluginConnectorDraft(scope: scope) } label: { Label("Add server", systemImage: "plus") }
                    .disabled(!connectorReady)
            }
            Text(scope == "global" ? "Global MCP servers are available to every project." : "Project entries override global servers with the same name. Changes apply on the next turn.")
                .font(.caption).foregroundStyle(FDTheme.muted)
            NativePluginSection(title: "MCP servers") {
                let entries = connectorRows.filter { matches($0, fields: ["name", "command", "url"]) }
                if entries.isEmpty && loadedScope == scope {
                    empty("No MCP servers", detail: "Add a server or paste an existing MCP configuration.")
                }
                ForEach(entries, id: \.self) { row in connectorRow(row) }
            }
            Text("Command and URL servers, environment variables, headers, and provider restrictions are stored by the daemon. Changes apply on the next turn.")
                .font(.caption).foregroundStyle(FDTheme.subtle)
        }
    }

    private var connectorRows: [JSON] {
        guard loadedScope == scope else { return [] }
        if scope != "global" { return connectors["merged"].array }
        return object(connectors["global"]).sorted { $0.key < $1.key }.map { name, entry in
            entry.setting("name", .string(name)).setting("scope", .string("global"))
        }
    }

    private var connectorReady: Bool { loadedScope == scope && busy == nil }

    private func connectorRow(_ row: JSON) -> some View {
        HStack(spacing: 12) {
            pluginIcon(row["name"].string, symbol: row["url"].string.isEmpty ? "terminal" : "globe")
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(row["name"].string).font(NativePreferences.shared.font(size: 13, weight: .semibold))
                    if scope != "global" { Text(row["scope"].string == "global" ? "Global" : "Project").font(.caption2).foregroundStyle(FDTheme.info) }
                }
                Text(row["url"].string.isEmpty ? ([row["command"].string] + row["args"].array.map(\.string)).joined(separator: " ") : row["url"].string)
                    .font(NativePreferences.shared.font(size: 11, surface: "code")).foregroundStyle(FDTheme.muted).lineLimit(1)
                if !row["providers"].array.isEmpty {
                    Text(row["providers"].array.map(\.string).joined(separator: ", ") + " only").font(.caption2).foregroundStyle(FDTheme.subtle)
                }
            }
            Spacer()
            Toggle("Enabled", isOn: Binding(get: { row["enabled"] != .bool(false) }, set: { value in
                Task { await toggleConnector(row, enabled: value) }
            })).toggleStyle(.switch).labelsHidden().controlSize(.small).disabled(!connectorReady)
                .help("Enable \(row["name"].string)")
            Menu {
                Button(scope != "global" && row["scope"].string == "global" ? "Override for this project…" : "Edit…") {
                    editor = NativePluginConnectorDraft(scope: scope, name: row["name"].string, entry: row)
                }
                if scope == "global" || row["scope"].string == "workspace" {
                    Button("Remove server", role: .destructive) {
                        removal = NativePluginRemoval(title: "Remove \(row["name"].string)\(scope == "global" ? " from every project" : " from this project")?", connector: row["name"].string, scope: scope)
                    }
                }
            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 24).disabled(!connectorReady)
        }.padding(14)
    }

    private func pluginIcon(_ name: String, symbol: String? = nil) -> some View {
        Group {
            if let symbol { Image(systemName: symbol).font(.system(size: 16)) }
            else { Text(String(name.prefix(2))).font(NativePreferences.shared.font(size: 15, weight: .semibold)) }
        }
        .foregroundStyle(FDTheme.accent).frame(width: 38, height: 38)
        .background(FDTheme.raised, in: .rect(cornerRadius: 10))
    }

    private func feedback(_ text: String, isError: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: isError ? "exclamationmark.circle" : "checkmark.circle")
            Text(text).textSelection(.enabled)
            Spacer()
            Button { if isError { error = nil } else { notice = nil } } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain).help("Dismiss")
        }.font(NativePreferences.shared.font(size: 13)).foregroundStyle(isError ? FDTheme.danger : FDTheme.accent)
    }

    private func empty(_ title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(NativePreferences.shared.font(size: 13, weight: .medium))
            Text(detail).font(.caption).foregroundStyle(FDTheme.muted)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
    }

    private func object(_ value: JSON) -> [String: JSON] {
        if case .object(let fields) = value { return fields }
        return [:]
    }

    private func matches(_ value: JSON, fields: [String]) -> Bool {
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return search.isEmpty || fields.contains { value[$0].string.localizedCaseInsensitiveContains(search) }
    }

    @MainActor private func load() async {
        let identity = UUID()
        loadID = identity
        loading = true
        error = nil
        defer { if loadID == identity { loading = false } }
        do {
            if tab == "skills" {
                let result = try await store.request(path: "/api/skills")
                guard loadID == identity, !Task.isCancelled else { return }
                library = result
            } else {
                try await loadCatalog()
                guard loadID == identity, !Task.isCancelled else { return }
                await loadConnectors()
            }
        } catch is CancellationError {} catch { if loadID == identity { self.error = error.localizedDescription } }
    }

    @MainActor private func loadCatalog() async throws {
        let identity = UUID()
        catalogLoadID = identity
        do {
            let result = try await store.request(path: "/api/connectors/catalog")
            guard catalogLoadID == identity, !Task.isCancelled else { return }
            catalog = result["servers"].array
        } catch {
            guard catalogLoadID == identity, !Task.isCancelled else { return }
            throw error
        }
    }

    @MainActor private func loadConnectors() async {
        let target = scope
        let identity = UUID()
        connectorLoadID = identity
        loadedScope = nil
        do {
            let result = try await store.request(path: "/api/connectors" + (target == "global" ? "" : "?workspace_id=" + encoded(target)))
            guard connectorLoadID == identity, scope == target, !Task.isCancelled else { return }
            connectors = result
            loadedScope = target
        } catch is CancellationError {} catch { if connectorLoadID == identity, target == scope { self.error = error.localizedDescription } }
    }

    @MainActor private func invalidateReads() {
        loadID = UUID()
        connectorLoadID = UUID()
        catalogLoadID = UUID()
        loading = false
    }

    @MainActor private func searchSkills() async {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        searching = true
        registryError = nil
        defer { if term == query.trimmingCharacters(in: .whitespacesAndNewlines) { searching = false } }
        do {
            let result = try await store.request(path: "/api/skills/registry?q=" + encoded(term) + "&limit=30")
            guard !Task.isCancelled, term == query.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
            registry = result["skills"].array
        } catch is CancellationError {} catch { if !Task.isCancelled { registryError = error.localizedDescription } }
    }

    @MainActor private func installPlugin(_ plugin: JSON, apiKey: String? = nil) async -> Bool {
        guard busy == nil else { return false }
        let id = plugin["id"].string
        invalidateReads()
        busy = id; error = nil; notice = nil
        defer { busy = nil }
        do {
            if let apiKey {
                _ = try await store.request(path: "/api/connectors/catalog/install", method: "POST", body: .object(["id": .string(id), "api_key": .string(apiKey)]))
                keyServer = nil
            } else {
                let response = try await store.request(path: "/api/connectors/oauth/start", method: "POST", body: .object(["id": .string(id)]))
                guard let url = URL(string: response["authorization_url"].string), ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
                    throw PilotError("The daemon did not return a valid sign-in URL.")
                }
                guard NSWorkspace.shared.open(url) else { throw PilotError("Could not open your browser for sign-in.") }
                notice = "Finish signing in to \(plugin["name"].string) in your browser."
                var connected = false
                for _ in 0..<120 {
                    try await Task.sleep(for: .milliseconds(1500))
                    try await loadCatalog()
                    if catalog.contains(where: { $0["id"].string == id && $0["connected"].bool }) { connected = true; break }
                }
                if !connected {
                    notice = "Still waiting for \(plugin["name"].string). Finish browser sign-in, then refresh or reconnect."
                    return false
                }
            }
            try await loadCatalog()
            await loadConnectors()
            notice = "\(plugin["name"].string) connected. Available to agents on the next turn."
            return true
        } catch is CancellationError { return false }
        catch { self.error = error.localizedDescription; return false }
    }

    @MainActor private func installSkill(source: String, name: String, busyID: String) async {
        guard busy == nil else { return }
        invalidateReads()
        busy = busyID; error = nil
        defer { busy = nil }
        do {
            _ = try await store.request(path: "/api/skills/install", method: "POST", body: .object(["source": .string(source), "skill": .string(name)]))
            library = try await store.request(path: "/api/skills")
            await searchSkills()
            notice = "Installed /\(name). Available to agents on new turns."
        } catch { self.error = error.localizedDescription }
    }

    @MainActor private func writeConnectors(target: String, mutate: ([String: JSON]) throws -> [String: JSON]) async -> Bool {
        guard busy == nil, loadedScope == target, scope == target else {
            error = "Wait for this scope to load, then try again."
            return false
        }
        invalidateReads()
        busy = "connectors"; error = nil
        defer { busy = nil }
        do {
            // Re-read immediately before writing: the daemon replaces the selected map.
            let latest = try await store.request(path: "/api/connectors" + (target == "global" ? "" : "?workspace_id=" + encoded(target)))
            let current = object(latest[target == "global" ? "global" : "workspace"])
            let updated = try mutate(current)
            var body: [String: JSON] = ["scope": .string(target == "global" ? "global" : "workspace"), "mcpServers": .object(updated)]
            if target != "global" { body["workspace_id"] = .string(target) }
            _ = try await store.request(path: "/api/connectors", method: "PUT", body: .object(body))
            await loadConnectors()
            try await loadCatalog()
            notice = "MCP servers saved. Changes apply on the next turn."
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    @MainActor private func saveConnector(_ draft: NativePluginConnectorDraft) async -> Bool {
        do {
            let entry = try draft.entry()
            return await writeConnectors(target: draft.scope) { current in
                var next = current
                if draft.originalName != draft.name && !draft.originalName.isEmpty { next.removeValue(forKey: draft.originalName) }
                if current[draft.name] != nil && draft.originalName != draft.name {
                    throw PilotError("A server named \(draft.name) already exists in this scope.")
                }
                next[draft.name] = entry
                return next
            }
        } catch { self.error = error.localizedDescription; return false }
    }

    @MainActor private func importConnectors(_ entries: [String: JSON]) async -> Bool {
        await writeConnectors(target: scope) { current in current.merging(entries) { _, imported in imported } }
    }

    @MainActor private func toggleConnector(_ row: JSON, enabled: Bool) async {
        let name = row["name"].string
        _ = await writeConnectors(target: scope) { current in
            var next = current
            var entry = object(current[name] ?? row)
            entry.removeValue(forKey: "name"); entry.removeValue(forKey: "scope")
            entry["enabled"] = .bool(enabled)
            next[name] = .object(entry)
            return next
        }
    }

    @MainActor private func remove(_ item: NativePluginRemoval) async {
        if let name = item.skill {
            guard busy == nil else { return }
            invalidateReads()
            busy = name; error = nil
            defer { busy = nil }
            do {
                _ = try await store.request(path: "/api/skills/" + encoded(name), method: "DELETE")
                library = try await store.request(path: "/api/skills")
                await searchSkills()
                notice = "Removed /\(name)."
            } catch { self.error = error.localizedDescription }
        } else if let name = item.connector {
            _ = await writeConnectors(target: item.scope) { current in var next = current; next.removeValue(forKey: name); return next }
        }
    }

    private func encoded(_ string: String) -> String {
        string.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }
}

private struct NativePluginSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(NativePreferences.shared.font(size: 13, weight: .semibold)).foregroundStyle(FDTheme.secondary)
            VStack(alignment: .leading, spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(FDTheme.surface, in: .rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(FDTheme.hairline))
        }
    }
}

private struct NativePluginRemoval {
    let title: String
    var skill: String?
    var connector: String?
    var scope = "global"
}

private struct NativePluginKeySheet: View {
    @Environment(\.dismiss) private var dismiss
    let server: JSON
    let save: (String) async -> Bool
    @State private var key = ""
    @State private var busy = false
    @State private var failed = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Connect \(server["name"].string)").font(.title3.weight(.semibold))
            Text("The daemon stores this credential for your agents.").foregroundStyle(FDTheme.muted)
            SecureField(server["id"].string == "github" ? "Personal access token" : "API key", text: $key).textFieldStyle(.roundedBorder)
            if failed { Text("Could not connect. Check the credential and try again.").font(.caption).foregroundStyle(FDTheme.danger) }
            HStack {
                Spacer()
                Button("Cancel") { key = ""; dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                Button(busy ? "Connecting…" : "Connect") {
                    busy = true
                    Task {
                        if await save(key.trimmingCharacters(in: .whitespacesAndNewlines)) { key = ""; dismiss() }
                        else { failed = true }
                        busy = false
                    }
                }.keyboardShortcut(.defaultAction).disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
            }
        }.padding(26).frame(width: 440)
    }
}

private struct NativePluginConnectorDraft: Identifiable {
    let id = UUID()
    let scope: String
    var originalName = ""
    var name = ""
    var mode = "command"
    var command = ""
    var arguments = ""
    var url = ""
    var environment = ""
    var headers = ""
    var providers = ""
    var enabled = true
    var originalEntry: [String: JSON] = [:]

    init(scope: String, name: String = "", entry: JSON = .null) {
        self.scope = scope; self.originalName = name; self.name = name
        command = entry["command"].string
        arguments = entry["args"].array.map(\.string).joined(separator: "\n")
        url = entry["url"].string; mode = url.isEmpty ? "command" : "url"
        providers = entry["providers"].array.map(\.string).joined(separator: ", ")
        enabled = entry["enabled"] != .bool(false)
        if case .object(let fields) = entry { originalEntry = fields }
        if case .object(let values) = entry["env"] { environment = values.sorted { $0.key < $1.key }.map { $0.key + "=" + $0.value.string }.joined(separator: "\n") }
        if case .object(let values) = entry["headers"] { headers = values.sorted { $0.key < $1.key }.map { $0.key + ": " + $0.value.string }.joined(separator: "\n") }
    }

    func entry() throws -> JSON {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PilotError("Enter a server name.") }
        var fields = originalEntry
        ["name", "scope", "command", "args", "env", "url", "headers"].forEach { fields.removeValue(forKey: $0) }
        fields["enabled"] = .bool(enabled)
        fields["providers"] = .array(providers.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespacesAndNewlines)) }.filter { !$0.string.isEmpty })
        if mode == "command" {
            guard !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PilotError("Enter a command.") }
            fields["command"] = .string(command.trimmingCharacters(in: .whitespacesAndNewlines))
            fields["args"] = .array(arguments.split(separator: "\n", omittingEmptySubsequences: false).filter { !$0.isEmpty }.map { .string(String($0)) })
            fields["env"] = .object(try pairs(environment, separator: "="))
        } else {
            guard let parsed = URL(string: url.trimmingCharacters(in: .whitespacesAndNewlines)), ["https", "http"].contains(parsed.scheme?.lowercased() ?? ""), parsed.host != nil else {
                throw PilotError("Enter an HTTP or HTTPS server URL.")
            }
            fields["url"] = .string(parsed.absoluteString)
            fields["headers"] = .object(try pairs(headers, separator: ":"))
        }
        return .object(fields)
    }

    private func pairs(_ text: String, separator: Character) throws -> [String: JSON] {
        var result: [String: JSON] = [:]
        for line in text.split(separator: "\n") {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            guard let index = line.firstIndex(of: separator) else { throw PilotError("Each entry needs a \(separator) separator.") }
            let key = line[..<index].trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { throw PilotError("Entry names cannot be empty.") }
            result[key] = .string(line[line.index(after: index)...].trimmingCharacters(in: .whitespaces))
        }
        return result
    }
}

private struct NativePluginConnectorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var draft: NativePluginConnectorDraft
    let onSave: (NativePluginConnectorDraft) async -> Bool
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(draft.originalName.isEmpty ? "Add MCP server" : "Edit MCP server").font(.title3.weight(.semibold))
            Form {
                TextField("Name", text: $draft.name)
                Picker("Connection", selection: $draft.mode) { Text("Command").tag("command"); Text("URL").tag("url") }.pickerStyle(.segmented)
                if draft.mode == "command" {
                    TextField("Executable", text: $draft.command, prompt: Text("npx"))
                    LabeledContent("Arguments, one per line") { textArea($draft.arguments, height: 78) }
                    LabeledContent("Environment, KEY=value") { textArea($draft.environment, height: 78) }
                } else {
                    TextField("Server URL", text: $draft.url, prompt: Text("https://mcp.example.com/mcp"))
                    LabeledContent("Headers, Name: value") { textArea($draft.headers, height: 90) }
                }
                TextField("Providers", text: $draft.providers, prompt: Text("All agents, or comma-separated provider IDs"))
                Toggle("Enabled", isOn: $draft.enabled)
            }.formStyle(.grouped)
            if let error { Text(error).font(.caption).foregroundStyle(FDTheme.danger) }
            HStack {
                Text(draft.scope == "global" ? "Available to every project" : "Only this project").font(.caption).foregroundStyle(FDTheme.muted)
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                Button(busy ? "Saving…" : "Save") {
                    do {
                        draft.name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
                        _ = try draft.entry()
                        error = nil; busy = true
                        Task {
                            if await onSave(draft) { dismiss() } else { error = "Could not save the server. Check the error in Plugins and retry." }
                            busy = false
                        }
                    } catch { self.error = error.localizedDescription }
                }.keyboardShortcut(.defaultAction).disabled(busy)
            }
        }.padding(24).frame(width: 640, height: 550)
    }

    private func textArea(_ binding: Binding<String>, height: CGFloat) -> some View {
        TextEditor(text: binding).font(NativePreferences.shared.font(size: 13, surface: "code")).frame(height: height)
            .scrollContentBackground(.hidden).padding(5).background(FDTheme.raised, in: .rect(cornerRadius: 5))
    }
}

private struct NativePluginImportSheet: View {
    @Environment(\.dismiss) private var dismiss
    let save: ([String: JSON]) async -> Bool
    @State private var text = ""
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Import MCP servers").font(.title3.weight(.semibold))
            Text("Paste an mcpServers object or a name-to-server map. Entries merge into the selected scope, replacing servers with matching names.")
                .font(.caption).foregroundStyle(FDTheme.muted)
            TextEditor(text: $text).font(NativePreferences.shared.font(size: 13, surface: "code")).frame(height: 240)
            if let error { Text(error).font(.caption).foregroundStyle(FDTheme.danger) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
                Button(busy ? "Importing…" : "Import") {
                    do {
                        let parsed = try JSON.decode(Data(text.utf8))
                        let entries = parsed["mcpServers"] == .null ? parsed : parsed["mcpServers"]
                        guard case .object(let map) = entries, !map.isEmpty else { throw PilotError("Paste an object containing at least one server.") }
                        for (name, entry) in map {
                            guard case .object = entry, !name.isEmpty, !entry["command"].string.isEmpty || !entry["url"].string.isEmpty else {
                                throw PilotError("Server \(name) needs a command or URL.")
                            }
                        }
                        error = nil; busy = true
                        Task {
                            if await save(map) { dismiss() } else { error = "Could not import servers. Check the error in Plugins and retry." }
                            busy = false
                        }
                    } catch { self.error = error.localizedDescription }
                }.keyboardShortcut(.defaultAction).disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 600)
    }
}
