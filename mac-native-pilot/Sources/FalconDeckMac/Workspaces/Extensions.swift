import AppKit
import Observation
import SwiftUI
import WebKit

/// The daemon owns extension enablement, grants and synchronized projections.
@MainActor @Observable final class NativeExtensionRepository {
    let hostID: String?
    var snapshot: JSON = .object(["catalog": .array([]), "views": .array([])])
    var error: String?
    var loading = false
    var busy = false
    @ObservationIgnored private var loadID = UUID()

    init(hostID: String? = nil) { self.hostID = hostID }

    var catalog: [JSON] { snapshot["catalog"].array }

    func adopt(_ snapshot: JSON) {
        loadID = UUID()
        loading = false
        self.snapshot = snapshot
    }

    func refresh(_ store: AppStore) async {
        let identity = UUID()
        loadID = identity
        loading = true
        defer { if loadID == identity { loading = false } }
        do {
            let result = try await store.request(path: "/api/extensions", hostID: hostID)
            guard loadID == identity, !Task.isCancelled else { return }
            snapshot = result
            error = nil
        } catch { if loadID == identity, !Task.isCancelled { self.error = error.localizedDescription } }
    }

    func setEnabled(_ enabled: Bool, extension item: JSON, grantPermissions: [String] = [], store: AppStore) async {
        guard !busy else { return }
        busy = true
        error = nil
        loadID = UUID()
        loading = false
        defer { busy = false }
        do {
            for permission in grantPermissions {
                _ = try await store.request(path: "/api/extensions/\(item["id"].string)/permissions", method: "PATCH", body: .object(["permission": .string(permission), "granted": .bool(true)]), hostID: hostID)
            }
            _ = try await store.request(path: "/api/extensions/\(item["id"].string)", method: "PATCH", body: .object(["enabled": .bool(enabled)]), hostID: hostID)
            await refresh(store)
        } catch { self.error = error.localizedDescription }
    }

    func setPermission(_ permission: String, granted: Bool, extension item: JSON, store: AppStore) async {
        guard !busy else { return }
        busy = true
        error = nil
        loadID = UUID()
        loading = false
        defer { busy = false }
        do {
            _ = try await store.request(path: "/api/extensions/\(item["id"].string)/permissions", method: "PATCH", body: .object(["permission": .string(permission), "granted": .bool(granted)]), hostID: hostID)
            await refresh(store)
        } catch { self.error = error.localizedDescription }
    }

    func invoke(_ store: AppStore, extensionID: String, actionID: String, input: JSON, target: JSON) async throws -> JSON {
        error = nil
        loadID = UUID()
        loading = false
        let response = try await store.request(path: "/api/extensions/\(extensionID)/actions/\(actionID)", method: "POST", body: .object(["input": input, "target": target]), hostID: hostID)
        await refresh(store)
        return response
    }
}

struct NativeExtensionsView: View {
    let store: AppStore
    let hostID: String?
    @State private var repository: NativeExtensionRepository
    @State private var query = ""
    @State private var enableRequest: JSON?
    @State private var openPanel: NativeExtensionPanelSelection?

    init(store: AppStore) {
        self.store = store
        self.hostID = store.selectedHostID
        _repository = State(initialValue: NativeExtensionRepository(hostID: store.selectedHostID))
    }

    private var matching: [JSON] {
        repository.catalog.filter { item in
            query.isEmpty || ["name", "id", "source"].contains { item[$0].string.localizedCaseInsensitiveContains(query) }
        }.sorted { a, b in a["enabled"].bool != b["enabled"].bool ? a["enabled"].bool : a["name"].string < b["name"].string }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("Extensions", systemImage: "puzzlepiece.extension").font(.system(size: 18, weight: .semibold))
                Spacer()
                if repository.loading { ProgressView().controlSize(.small) }
                Button { Task { await repository.refresh(store) } } label: { Image(systemName: "arrow.clockwise") }.help("Refresh extensions")
            }.padding(.horizontal, 24).padding(.vertical, 16)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Manage extensions installed on this FalconDeck. Official extensions are built and maintained by FalconDeck.").foregroundStyle(FDTheme.muted)
                    TextField("Search installed extensions", text: $query).textFieldStyle(.roundedBorder)
                    if let error = repository.error { Text(error).foregroundStyle(FDTheme.danger).textSelection(.enabled) }
                    if repository.catalog.isEmpty && !repository.loading {
                        NativeEmptyState(symbol: "puzzlepiece.extension", title: "No extensions installed", detail: "Extensions installed in your daemon will appear here.")
                    } else if matching.isEmpty {
                        Text("No installed extensions match “\(query)”.").foregroundStyle(FDTheme.muted).padding(.vertical, 20)
                    }
                    ForEach(matching, id: \.self) { item in extensionCard(item) }
                }.padding(24).frame(maxWidth: 896).frame(maxWidth: .infinity)
            }
        }.background(FDTheme.surface)
            .task {
                repository.adopt(store.extensionsForHost(hostID))
                await repository.refresh(store)
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(5)) } catch { return }
                    await repository.refresh(store)
                }
            }
            .onChange(of: store.extensionsForHost(hostID)) { _, snapshot in repository.adopt(snapshot) }
            .sheet(isPresented: Binding(get: { enableRequest != nil }, set: { if !$0 && !repository.busy { enableRequest = nil } })) { permissionPrompt }
            .sheet(item: $openPanel) { panel in
                NativeExtensionPanel(store: store, extensionID: panel.extensionID, panelID: panel.panelID, hostID: hostID, onClose: { openPanel = nil }).frame(minWidth: 900, minHeight: 620)
            }
    }

    private func extensionCard(_ item: JSON) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(item["name"].string).font(.headline)
                        if item["bundled"].bool { Text("Official").font(.caption).padding(.horizontal, 7).padding(.vertical, 3).background(FDTheme.hover, in: Capsule()) }
                        Text(item["status"].string.capitalized).font(.caption).foregroundStyle(item["status"].string == "error" ? FDTheme.danger : item["enabled"].bool ? FDTheme.accent : FDTheme.muted)
                    }
                    Text("\(item["id"].string) · v\(item["version"].string) · \(item["source"].string)").font(.caption).foregroundStyle(FDTheme.muted).textSelection(.enabled)
                }
                Spacer()
                Button(item["enabled"].bool ? "Disable" : "Enable") {
                    let missing = missingPermissions(item)
                    if !item["enabled"].bool && !missing.isEmpty { enableRequest = item }
                    else { Task { await repository.setEnabled(!item["enabled"].bool, extension: item, store: store) } }
                }.disabled(repository.busy || !store.isConnected)
            }
            ForEach(item["permissions"].array, id: \.self) { permission in
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(NativeExtensionPermissions.title(permission.string)).font(.system(size: 13, weight: .medium))
                        Text(NativeExtensionPermissions.detail(permission.string)).font(.caption).foregroundStyle(FDTheme.muted)
                    }
                    Spacer()
                    let granted = item["granted_permissions"].array.contains(permission)
                    Button(granted ? "Revoke" : "Grant") { Task { await repository.setPermission(permission.string, granted: !granted, extension: item, store: store) } }.disabled(repository.busy || !store.isConnected)
                }.padding(12).background(FDTheme.surface, in: RoundedRectangle(cornerRadius: 8))
            }
            if !item["last_error"].string.isEmpty { Text(item["last_error"].string).foregroundStyle(FDTheme.danger).font(.caption).textSelection(.enabled) }
            if item["enabled"].bool {
                HStack {
                    ForEach(item["contributes"]["panels"].array, id: \.self) { panel in
                        Button("Open \(panel["title"].string.isEmpty ? item["name"].string : panel["title"].string)") {
                            openPanel = NativeExtensionPanelSelection(extensionID: item["id"].string, panelID: panel["id"].string)
                        }
                    }
                }
            }
            let unsupported = item["contributes"]["unsupported"].array
            if !unsupported.isEmpty { Text("Unsupported contributions: \(unsupported.map { $0["kind"].string }.joined(separator: ", ")).").font(.caption).foregroundStyle(FDTheme.warning) }
        }.padding(18).background(FDTheme.raised, in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(FDTheme.line))
    }

    private var permissionPrompt: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let item = enableRequest {
                Text("Enable \(item["name"].string)?").font(.title2.weight(.semibold))
                Text("This extension requests the following access:").foregroundStyle(FDTheme.muted)
                ForEach(missingPermissions(item), id: \.self) { permission in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(NativeExtensionPermissions.title(permission)).font(.headline)
                        Text(NativeExtensionPermissions.detail(permission)).foregroundStyle(FDTheme.muted)
                    }
                }
                if let error = repository.error { Text(error).foregroundStyle(FDTheme.danger) }
                HStack {
                    Spacer()
                    Button("Cancel") { enableRequest = nil }.keyboardShortcut(.cancelAction).disabled(repository.busy)
                    Button("Allow and enable") {
                        Task {
                            await repository.setEnabled(true, extension: item, grantPermissions: missingPermissions(item), store: store)
                            if repository.error == nil { enableRequest = nil }
                        }
                    }.keyboardShortcut(.defaultAction).disabled(repository.busy)
                }
            }
        }.padding(28).frame(width: 520).background(FDTheme.surface)
    }

    private func missingPermissions(_ item: JSON) -> [String] {
        item["permissions"].array.filter { !item["granted_permissions"].array.contains($0) }.map(\.string)
    }
}

private struct NativeExtensionPanelSelection: Identifiable {
    let extensionID: String
    let panelID: String
    var id: String { extensionID + ":" + panelID }
}

enum NativeExtensionPermissions {
    static func title(_ permission: String) -> String {
        switch permission {
        case "threads:read": "Read task summaries"
        case "agent-tools:register": "Offer tools to agents"
        case "automations:manage-owned": "Manage owned automations"
        default: permission
        }
    }
    static func detail(_ permission: String) -> String {
        switch permission {
        case "threads:read": "Titles, providers, status, timestamps and pending-request counts. Messages and transcripts stay private."
        case "agent-tools:register": "Publish declared tools to agents running in FalconDeck. Revocation removes them from new sessions and rejects further calls."
        case "automations:manage-owned": "Create and control scheduled agent check-ins belonging to this extension. Other automations stay private."
        default: "A capability requested by this extension."
        }
    }
}

struct NativeExtensionPanel: View {
    let store: AppStore
    let extensionID: String
    let panelID: String
    let hostID: String?
    var onClose: (() -> Void)? = nil
    @State private var repository: NativeExtensionRepository
    @State private var actionBusy = false
    @Environment(\.colorScheme) private var colorScheme

    init(store: AppStore, extensionID: String, panelID: String, onClose: (() -> Void)? = nil) {
        self.init(store: store, extensionID: extensionID, panelID: panelID, hostID: store.selectedHostID, onClose: onClose)
    }

    init(store: AppStore, extensionID: String, panelID: String, hostID: String?, onClose: (() -> Void)? = nil) {
        self.store = store
        self.extensionID = extensionID
        self.panelID = panelID
        self.hostID = hostID
        self.onClose = onClose
        _repository = State(initialValue: NativeExtensionRepository(hostID: hostID))
    }

    private var item: JSON { repository.catalog.first { $0["id"].string == extensionID } ?? .null }
    private var contribution: JSON { item["contributes"]["panels"].array.first { $0["id"].string == panelID } ?? .null }
    private var title: String { contribution["title"].string.isEmpty ? item["name"].string : contribution["title"].string }
    private var isTrusted: Bool {
        item["bundled"].bool && NativeExtensionCompatibilityHost.supported.contains(extensionID + ":" + panelID)
    }
    private var document: JSON {
        let published = repository.snapshot["views"].array.first { $0["extension_id"].string == extensionID && $0["view_id"].string == contribution["view"].string && $0["scope"] == .null }?["value"] ?? .null
        return NativeExtensionDocument.resolve(published: published, fallback: contribution["ui"])
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: extensionID == "falcondeck.notes" ? "note.text" : "rectangle.split.3x1")
                Text(title.isEmpty ? "Extension" : title).font(.system(size: 18, weight: .semibold))
                if title != item["name"].string { Text(item["name"].string).font(.caption).foregroundStyle(FDTheme.muted) }
                Spacer()
                if repository.loading || actionBusy { ProgressView().controlSize(.small) }
                Button { Task { await repository.refresh(store) } } label: { Image(systemName: "arrow.clockwise") }.help("Refresh panel")
                if let onClose { Button(action: onClose) { Image(systemName: "xmark") }.help("Close panel").keyboardShortcut(.cancelAction) }
            }.padding(.horizontal, 24).padding(.vertical, 16)
            Divider()
            if let error = repository.error { Text(error).font(.caption).foregroundStyle(FDTheme.danger).frame(maxWidth: .infinity, alignment: .leading).padding(12).background(FDTheme.raised) }
            if repository.loading && item == .null {
                ProgressView("Loading extension…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !item["enabled"].bool || contribution == .null {
                NativeEmptyState(symbol: "puzzlepiece.extension", title: "Panel unavailable", detail: "Enable this extension in Extensions to use its panels.")
            } else if isTrusted {
                NativeExtensionCompatibilityHost(store: store, repository: repository, extensionID: extensionID, panelID: panelID, appearance: colorScheme == .dark ? "dark" : "light", appearanceSettings: NativePreferences.shared.exportSettings(), hostID: hostID)
            } else if NativeExtensionDocument.valid(document) {
                ScrollView {
                    NativeExtensionDocumentView(document: document, busy: actionBusy || !store.isConnected) { binding in
                        actionBusy = true
                        Task {
                            defer { actionBusy = false }
                            do { _ = try await repository.invoke(store, extensionID: extensionID, actionID: binding["actionId"].string, input: binding["input"], target: binding["target"]) }
                            catch { repository.error = error.localizedDescription }
                        }
                    }.padding(24).frame(maxWidth: 896).frame(maxWidth: .infinity)
                }
            } else {
                NativeEmptyState(symbol: "puzzlepiece.extension", title: "Unsupported panel", detail: "This extension has not published a supported version 1 panel. Its data remains safely in the daemon.")
            }
        }.background(FDTheme.surface)
            .onChange(of: store.extensionsForHost(hostID)) { _, snapshot in repository.adopt(snapshot) }
            .task(id: extensionID + ":" + panelID) {
                repository.adopt(store.extensionsForHost(hostID))
                await repository.refresh(store)
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(3)) } catch { return }
                    await repository.refresh(store)
                }
            }
    }
}

enum NativeExtensionDocument {
    static func resolve(published: JSON, fallback: JSON) -> JSON {
        // A published document with malformed fields must remain unsupported;
        // replacing it with the manifest would hide the incompatible update.
        published.fields["version"] != nil && published.fields["root"] != nil ? published : fallback
    }

    static func valid(_ document: JSON) -> Bool {
        guard hasOnlyKeys(document, ["version", "root"]), document["version"] == .number(1) else { return false }
        var count = 0
        return validNode(document["root"], depth: 1, count: &count)
    }

    // Keep these bounds and schemas aligned with client-core/extension-ui.ts.
    private static let tones: Set<String> = ["default", "muted", "accent", "success", "warning", "danger", "info", "gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"]
    private static let gaps: Set<String> = ["none", "small", "medium", "large"]

    private static func validNode(_ node: JSON, depth: Int, count: inout Int) -> Bool {
        count += 1
        guard depth <= 32, count <= 256 else { return false }
        switch node["type"].string {
        case "stack", "row", "list":
            let type = node["type"].string
            let childrenKey = type == "list" ? "items" : "children"
            let allowed = type == "row" ? ["type", "gap", "wrap", "children"] : type == "stack" ? ["type", "gap", "children"] : ["type", "items"]
            guard hasOnlyKeys(node, allowed), case .array(let children) = node[childrenKey], children.count <= 256 else { return false }
            if type != "list", !optionalEnum(node, key: "gap", values: gaps) { return false }
            if type == "row", !optionalBoolean(node, key: "wrap") { return false }
            return children.allSatisfy { validNode($0, depth: depth + 1, count: &count) }
        case "text":
            return hasOnlyKeys(node, ["type", "text", "style", "tone"]) && text(node["text"])
                && optionalEnum(node, key: "style", values: ["body", "heading", "caption", "mono"])
                && optionalEnum(node, key: "tone", values: tones)
        case "badge":
            return hasOnlyKeys(node, ["type", "text", "tone"]) && text(node["text"]) && optionalEnum(node, key: "tone", values: tones)
        case "divider": return hasOnlyKeys(node, ["type"])
        case "button":
            return hasOnlyKeys(node, ["type", "label", "action", "variant", "disabled"]) && text(node["label"], allowEmpty: false)
                && validAction(node["action"]) && optionalEnum(node, key: "variant", values: ["secondary", "primary", "ghost", "danger"])
                && optionalBoolean(node, key: "disabled")
        case "select":
            guard hasOnlyKeys(node, ["type", "id", "label", "multiple", "options", "binding"]), identifier(node["id"]), text(node["label"], allowEmpty: false),
                  optionalBoolean(node, key: "multiple"), case .array(let options) = node["options"], options.count <= 256,
                  validFilterBinding(node["binding"]) else { return false }
            var values: Set<String> = []
            return options.allSatisfy { option in
                hasOnlyKeys(option, ["value", "label", "tone"]) && text(option["value"], limit: 256) && !option["value"].string.isEmpty
                    && values.insert(option["value"].string).inserted && text(option["label"], allowEmpty: false)
                    && optionalEnum(option, key: "tone", values: tones)
            }
        case "state":
            return hasOnlyKeys(node, ["type", "state", "title", "description"]) && ["loading", "empty", "error"].contains(node["state"].string)
                && text(node["title"], allowEmpty: false) && (node.fields["description"] == nil || text(node["description"]))
        default: return false
        }
    }

    private static func validAction(_ action: JSON) -> Bool {
        guard hasOnlyKeys(action, ["actionId", "input", "target"]), identifier(action["actionId"]) else { return false }
        if let input = action.fields["input"] {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.withoutEscapingSlashes]
            guard let data = try? encoder.encode(input), data.count <= 64 * 1024 else { return false }
        }
        if let target = action.fields["target"] {
            guard hasOnlyKeys(target, ["kind", "id"]), text(target["kind"], limit: 64), !target["kind"].string.isEmpty,
                  text(target["id"], limit: 512), !target["id"].string.isEmpty else { return false }
        }
        return true
    }

    private static func validFilterBinding(_ binding: JSON) -> Bool {
        guard hasOnlyKeys(binding, ["view", "path", "operator"]), identifier(binding["view"]), binding["operator"] == .string("includes_any"),
              case .array(let path) = binding["path"], !path.isEmpty, path.count <= 16 else { return false }
        return path.allSatisfy { text($0, limit: 128) && !$0.string.isEmpty && !["__proto__", "constructor", "prototype"].contains($0.string) }
    }

    private static func hasOnlyKeys(_ value: JSON, _ allowed: [String]) -> Bool {
        guard case .object(let fields) = value else { return false }
        return fields.keys.allSatisfy(allowed.contains)
    }

    private static func identifier(_ value: JSON) -> Bool {
        guard case .string(let string) = value else { return false }
        return string.range(of: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", options: .regularExpression) != nil
    }

    private static func text(_ value: JSON, limit: Int = 4096, allowEmpty: Bool = true) -> Bool {
        guard case .string(let string) = value, string.unicodeScalars.count <= limit else { return false }
        return allowEmpty || !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func optionalEnum(_ value: JSON, key: String, values: Set<String>) -> Bool {
        value.fields[key] == nil || values.contains(value[key].string)
    }

    private static func optionalBoolean(_ value: JSON, key: String) -> Bool {
        if value.fields[key] == nil { return true }
        if case .bool = value[key] { return true }
        return false
    }
}

private struct NativeExtensionDocumentView: View {
    let document: JSON
    let busy: Bool
    let invoke: (JSON) -> Void
    @State private var selections: [String: Set<String>] = [:]

    var body: some View { node(document["root"]).frame(maxWidth: .infinity, alignment: .leading) }

    private func node(_ value: JSON) -> AnyView {
        switch value["type"].string {
        case "stack", "list":
            return AnyView(VStack(alignment: .leading, spacing: gap(value["gap"].string)) {
                ForEach(Array(value[value["type"].string == "list" ? "items" : "children"].array.enumerated()), id: \.offset) { node($0.element) }
            })
        case "row":
            return AnyView(ViewThatFits(in: .horizontal) {
                HStack(spacing: gap(value["gap"].string)) { ForEach(Array(value["children"].array.enumerated()), id: \.offset) { node($0.element) } }
                VStack(alignment: .leading, spacing: gap(value["gap"].string)) { ForEach(Array(value["children"].array.enumerated()), id: \.offset) { node($0.element) } }
            })
        case "text":
            return AnyView(Text(value["text"].string).font(value["style"].string == "heading" ? .headline : value["style"].string == "caption" ? .caption : value["style"].string == "mono" ? .system(.body, design: .monospaced) : .body).foregroundStyle(tone(value["tone"].string)).textSelection(.enabled))
        case "badge": return AnyView(Text(value["text"].string).font(.caption).foregroundStyle(tone(value["tone"].string)).padding(.horizontal, 8).padding(.vertical, 4).background(FDTheme.hover, in: Capsule()))
        case "divider": return AnyView(Divider())
        case "button": return AnyView(Button(value["label"].string) { invoke(value["action"]) }.disabled(value["disabled"].bool || busy))
        case "state": return AnyView(VStack(alignment: .leading, spacing: 6) { Text(value["title"].string).font(.headline); Text(value["description"].string).foregroundStyle(FDTheme.muted) }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(FDTheme.raised, in: RoundedRectangle(cornerRadius: 10)))
        case "select":
            return AnyView(VStack(alignment: .leading, spacing: 8) {
                Text(value["label"].string).font(.headline)
                ForEach(value["options"].array, id: \.self) { option in
                    Toggle(option["label"].string, isOn: Binding(get: { selections[value["id"].string, default: []].contains(option["value"].string) }, set: { selected in
                        var selectedValues = selections[value["id"].string, default: []]
                        if !value["multiple"].bool { selectedValues = [] }
                        if selected { selectedValues.insert(option["value"].string) } else { selectedValues.remove(option["value"].string) }
                        selections[value["id"].string] = selectedValues
                    })).toggleStyle(.checkbox)
                }
            })
        default: return AnyView(Text("Unsupported extension control").foregroundStyle(FDTheme.warning))
        }
    }
    private func gap(_ value: String) -> CGFloat { ["none": 0, "small": 8, "medium": 12, "large": 20][value] ?? 12 }
    private func tone(_ value: String) -> Color {
        switch value {
        case "danger", "red": FDTheme.danger
        case "warning", "orange", "yellow": FDTheme.warning
        case "accent", "success", "green": FDTheme.accent
        case "info", "blue": FDTheme.info
        case "muted", "gray", "purple", "pink": FDTheme.muted
        default: FDTheme.foreground
        }
    }
}
