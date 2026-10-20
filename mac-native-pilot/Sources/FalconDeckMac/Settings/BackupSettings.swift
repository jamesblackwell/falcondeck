import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Uses the same archive format and validation path as the other clients.
struct NativeBackupSettingsView: View {
    let store: AppStore
    @State private var archive: JSON?
    @State private var summary: JSON = .null
    @State private var filename = ""
    @State private var mappings: [String: String] = [:]
    @State private var busy = false
    @State private var message: String?
    @State private var failed = false
    @State private var confirmReset = false
    @State private var restoreClientPreferences = true

    var body: some View {
        Form {
            Section {
                LabeledContent("Full FalconDeck archive") {
                    Button("Export backup…", systemImage: "square.and.arrow.up") { Task { await export() } }
                        .disabled(busy || !store.isConnected)
                }
                Text("Includes project pins, daemon preferences, extension data, automations and connectors, together with this Mac’s appearance, sounds and shortcuts. Credentials and agent conversation storage stay with their owners.")
                    .font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
            } header: { Text("Export backup") }

            Section {
                if archive == nil {
                    LabeledContent("Restore from archive") {
                        Button("Select backup…", systemImage: "square.and.arrow.down") { Task { await inspect() } }
                            .disabled(busy || !store.isConnected)
                    }
                    Text("Choose a backup to review its contents before anything is imported.")
                        .font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
                } else {
                    LabeledContent("Archive", value: filename)
                    LabeledContent("Created", value: backupDate(summary["created_at"].string))
                    if !summary["app_version"].string.isEmpty { LabeledContent("FalconDeck version", value: summary["app_version"].string) }
                    HStack(spacing: 28) {
                        count("Projects", "workspace_count")
                        count("Extensions", "extension_count")
                        count("Automations", "automation_count")
                        count("Connectors", "connector_count")
                    }.padding(.vertical, 6)
                    ForEach(summary["workspaces"].array, id: \.self) { workspace in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Label(URL(fileURLWithPath: workspace["path"].string).lastPathComponent, systemImage: "folder")
                                Spacer()
                                Label(workspace["exists_on_disk"].bool ? "Found" : "Missing locally", systemImage: workspace["exists_on_disk"].bool ? "checkmark.circle" : "exclamationmark.triangle")
                                    .font(NativePreferences.shared.font(size: 11)).foregroundStyle(workspace["exists_on_disk"].bool ? Color.secondary : Color.orange)
                            }
                            TextField("Project path", text: Binding(get: { mappings[workspace["path"].string] ?? workspace["path"].string }, set: { mappings[workspace["path"].string] = $0 }))
                                .font(NativePreferences.shared.font(size: 11, surface: "code"))
                        }.padding(.vertical, 4)
                    }
                    if !summary["extensions"].array.isEmpty {
                        LabeledContent("Extension data", value: summary["extensions"].array.map(\.string).joined(separator: ", "))
                    }
                    if summary["has_client_preferences"].bool {
                        Toggle("Restore this Mac’s preferences", isOn: $restoreClientPreferences)
                    }
                    Text("Paths can be changed if a project moved. Missing folders are retained as saved projects. Import merges with this Mac’s configuration.")
                        .font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
                    HStack {
                        Button("Cancel") { archive = nil; summary = .null; mappings = [:] }
                        Spacer()
                        Button("Restore backup") { Task { await restore() } }.buttonStyle(.borderedProminent)
                    }.disabled(busy)
                }
            } header: { Text("Import backup") }

            Section {
                LabeledContent("Reset native preferences") {
                    Button("Reset preferences…", role: .destructive) { confirmReset = true }.disabled(busy)
                }
                    Text("Restores this app’s appearance, sounds and shortcuts to their defaults. Projects, messages, pairings and daemon settings are preserved.")
                    .font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
            } header: { Text("Local app data") }

            if let message {
                Section {
                    Label(message, systemImage: failed ? "exclamationmark.triangle" : "checkmark.circle")
                        .foregroundStyle(failed ? Color.red : Color.secondary).textSelection(.enabled)
                }
            }
            if busy { ProgressView().controlSize(.small) }
        }
        .formStyle(.grouped)
        .confirmationDialog("Reset native preferences?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset preferences", role: .destructive) {
                NativePreferences.shared.reset()
                failed = false; message = "Native preferences reset."
            }
        } message: { Text("Projects, conversations and daemon settings will remain available.") }
    }

    private func count(_ label: String, _ key: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(summary[key].int)").font(NativePreferences.shared.font(size: 18, weight: .semibold))
            Text(label).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
        }
    }

    @MainActor private func export() async {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.nameFieldStringValue = "falcondeck-backup-\(ISO8601DateFormatter().string(from: .now).replacingOccurrences(of: ":", with: "-" )).json"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        await perform {
            let daemon = try await store.request("/api/backup")
            let client = NativeArchivePreferences.clientBackup(NativePreferences.shared.exportSettings())
                .setting("dictation", NativeSpeechController.shared.exportConfiguration())
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(daemon.setting("client", client)).write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            message = "Backup exported to \(url.lastPathComponent)."
        }
    }

    @MainActor private func inspect() async {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        await perform {
            let resource = try url.resourceValues(forKeys: [.fileSizeKey])
            guard (resource.fileSize ?? 0) <= 100 * 1024 * 1024 else { throw PilotError("This archive exceeds the 100 MB import limit.") }
            let candidate = try JSON.decode(Data(contentsOf: url))
            guard candidate["version"].optionalInt != nil, case .object = candidate["daemon"] else { throw PilotError("This file is not a FalconDeck backup archive.") }
            let preview = try await store.request("/api/backup/inspect", method: "POST", body: candidate)
            archive = candidate; summary = preview; filename = url.lastPathComponent; mappings = [:]
            restoreClientPreferences = preview["has_client_preferences"].bool
        }
    }

    @MainActor private func restore() async {
        guard let archive else { return }
        await perform {
            let remapped = mappings.filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.key != $0.value }
            let result = try await store.request("/api/backup/import", method: "POST", body: .object([
                "backup": archive,
                "path_mappings": .object(remapped.mapValues(JSON.string)),
            ]))
            if restoreClientPreferences {
                NativePreferences.shared.importSettings(NativeArchivePreferences.nativeSettings(archive["client"]))
                NativeSpeechController.shared.importConfiguration(archive["client"]["dictation"])
                let layout = NativeArchivePreferences.restoreLayout(archive["client"])
                if case .bool(let visible) = layout["falcondeck.native.inspector"] { store.showInspector = visible }
                if case .bool(let visible) = layout["falcondeck.native.terminal"] { store.showTerminal = visible }
            }
            self.archive = nil; summary = .null
            message = "Restored \(result["workspaces_imported"].int) projects, \(result["extensions_imported"].int) extensions, \(result["automations_imported"].int) automations and \(result["connectors_imported"].int) connectors."
            await store.reconnect()
        }
    }

    @MainActor private func perform(_ action: () async throws -> Void) async {
        guard !busy else { return }
        busy = true; message = nil; failed = false
        defer { busy = false }
        do { try await action() }
        catch { message = error.localizedDescription; failed = true }
    }

    private func backupDate(_ value: String) -> String {
        if let date = ISO8601DateFormatter().date(from: value) { return date.formatted(date: .abbreviated, time: .shortened) }
        return value
    }
}

@MainActor enum NativeArchivePreferences {
    static func clientBackup(_ native: JSON) -> JSON {
        var appearance: [String: JSON] = [:]
        for key in NativePreferences.appearanceKeys where native[key] != .null { appearance[key] = native[key] }
        return .object([
            "appearance": .object(appearance),
            "sounds": .object(["enabled": native["soundEnabled"] == .null ? .bool(false) : native["soundEnabled"],
                               "soundId": .string(native["soundName"].string.isEmpty ? "glass" : native["soundName"].string.lowercased())]),
            "shortcuts": .object(["version": .number(1), "bindings": native["shortcuts"] == .null ? .object([:]) : native["shortcuts"],
                                  "followUpBehavior": native["followUpBehavior"] == .null ? .string("queue") : native["followUpBehavior"]]),
            "ui_preferences": .object(["native": native, "nativeLayout": collectLayout()]),
        ])
    }

    static func nativeSettings(_ client: JSON) -> JSON {
        if case .object = client["ui_preferences"]["native"] { return client["ui_preferences"]["native"] }
        var fields: [String: JSON] = [:]
        for key in NativePreferences.appearanceKeys where client["appearance"][key] != .null { fields[key] = client["appearance"][key] }
        if case .bool = client["sounds"]["enabled"] { fields["soundEnabled"] = client["sounds"]["enabled"] }
        let sounds = ["glass": "Glass", "ping": "Ping", "pop": "Pop", "tink": "Tink", "basso": "Basso", "blow": "Blow", "bottle": "Bottle", "frog": "Frog", "funk": "Funk", "hero": "Hero", "morse": "Morse", "purr": "Purr", "sosumi": "Sosumi", "submarine": "Submarine"]
        if let sound = sounds[client["sounds"]["soundId"].string] { fields["soundName"] = .string(sound) }
        if case .object = client["shortcuts"]["bindings"] { fields["shortcuts"] = client["shortcuts"]["bindings"] }
        if client["shortcuts"]["followUpBehavior"] != .null { fields["followUpBehavior"] = client["shortcuts"]["followUpBehavior"] }
        return .object(fields)
    }

    private static let layoutBooleans = ["native.sidebar.visible", "native.navigation.showHiddenProjects", "native.navigation.pinsExpanded", "native.navigation.projectsExpanded", "native.tasks.archived", "falcondeck.native.inspector", "falcondeck.native.terminal"]
    private static let layoutChoices = ["native.tasks.sort": ["last_updated", "created", "alphabetical", "priority"], "native.tasks.filter": ["all", "unread", "working", "attention"]]

    static func collectLayout(defaults: UserDefaults = .standard) -> JSON {
        var fields: [String: JSON] = [:]
        for key in layoutBooleans where defaults.object(forKey: key) != nil { fields[key] = .bool(defaults.bool(forKey: key)) }
        for (key, valid) in layoutChoices {
            if let value = defaults.string(forKey: key), valid.contains(value) { fields[key] = .string(value) }
        }
        return .object(fields)
    }

    @discardableResult static func restoreLayout(_ client: JSON, defaults: UserDefaults = .standard) -> JSON {
        let source = client["ui_preferences"]["nativeLayout"]
        var fields: [String: JSON] = [:]
        for key in layoutBooleans {
            if case .bool(let value) = source[key] { defaults.set(value, forKey: key); fields[key] = .bool(value) }
        }
        for (key, valid) in layoutChoices {
            if case .string(let value) = source[key], valid.contains(value) { defaults.set(value, forKey: key); fields[key] = .string(value) }
        }
        if source == .null {
            let old = client["ui_preferences"]
            if let valid = layoutChoices["native.tasks.sort"], valid.contains(old["threadSort"].string) {
                defaults.set(old["threadSort"].string, forKey: "native.tasks.sort")
            }
            if old["projectsCollapsed"] == .bool(true) || old["projectsCollapsed"] == .string("true") {
                defaults.set(false, forKey: "native.navigation.projectsExpanded")
            } else if old["projectsCollapsed"] == .bool(false) || old["projectsCollapsed"] == .string("false") {
                defaults.set(true, forKey: "native.navigation.projectsExpanded")
            }
        }
        return .object(fields)
    }
}
