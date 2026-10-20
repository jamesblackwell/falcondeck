import SwiftUI
import AppKit

private func agentSettingsFields(_ value: JSON) -> [String: JSON] {
    if case .object(let fields) = value { return fields }
    return [:]
}

private func agentSettingsLines(_ text: String) -> [String] {
    text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}

private func agentSettingsPairs(_ text: String, separator: Character = "=") throws -> JSON {
    var values: [String: JSON] = [:]
    for line in agentSettingsLines(text) {
        guard let index = line.firstIndex(of: separator) else { throw PilotError("Use one name\(separator)value entry per line.") }
        let name = String(line[..<index]).trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { throw PilotError("Every entry needs a name.") }
        values[name] = .string(String(line[line.index(after: index)...]).trimmingCharacters(in: .whitespaces))
    }
    return .object(values)
}

private func agentSettingsPairText(_ value: JSON, separator: String = "=") -> String {
    agentSettingsFields(value).keys.sorted().map { "\($0)\(separator)\(value[$0].string)" }.joined(separator: "\n")
}

private func agentSettingsEncoded(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+=?#/"))) ?? value
}

private func agentSettingsCopy(_ value: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(value, forType: .string)
}

private struct AgentSettingsNotice: View {
    var error: String?
    var message: String?
    var body: some View {
        if let error {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red).font(NativePreferences.shared.font(size: 13)).textSelection(.enabled)
        } else if let message {
            Label(message, systemImage: "checkmark.circle.fill")
                .foregroundStyle(.secondary).font(NativePreferences.shared.font(size: 13)).textSelection(.enabled)
        }
    }
}

private struct AgentSettingsMultiline: View {
    let title: String
    @Binding var text: String
    var hint: String = ""
    var height: CGFloat = 72
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(NativePreferences.shared.font(size: 13))
            TextEditor(text: $text).font(NativePreferences.shared.font(size: 13, surface: "code"))
                .frame(minHeight: height, maxHeight: height)
                .padding(5).background(.background).clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                .accessibilityLabel(title)
            if !hint.isEmpty { Text(hint).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary) }
        }
    }
}

private struct AgentSettingsProviderDraft: Identifiable {
    var id = UUID()
    var originalID: String?
    var providerID = ""
    var label = ""
    var executable = ""
    var arguments = ""
    var environment = ""
    var transport = "acp"
    var original: JSON = .object([:])

    init() {}
    init(providerID: String, entry: JSON) {
        originalID = providerID
        self.providerID = providerID
        label = entry["label"].string
        let command = entry["command"].array.map(\.string)
        executable = command.first ?? ""
        arguments = command.dropFirst().joined(separator: "\n")
        environment = agentSettingsPairText(entry["env"])
        transport = entry["transport"].string.isEmpty ? "auto" : entry["transport"].string
        original = entry
    }

    var valid: Bool {
        let name = providerID.trimmingCharacters(in: .whitespacesAndNewlines)
        return !name.isEmpty && name.range(of: "^[a-z0-9][a-z0-9_-]*$", options: .regularExpression) != nil
            && !["codex", "claude", "agy"].contains(name) && !executable.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func entry() throws -> JSON {
        var result = agentSettingsFields(original)
        result["label"] = .string(label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? providerID : label)
        result["command"] = .array(([executable.trimmingCharacters(in: .whitespacesAndNewlines)] + agentSettingsLines(arguments)).map(JSON.string))
        result["env"] = try agentSettingsPairs(environment)
        result["transport"] = .string(transport)
        return .object(result)
    }
}

private struct AgentSettingsProviderEditor: View {
    @State var draft: AgentSettingsProviderDraft
    var save: (AgentSettingsProviderDraft) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(draft.originalID == nil ? "Add ACP agent" : "Edit \(draft.label)").font(NativePreferences.shared.font(size: 22, weight: .bold))
            Form {
                TextField("Agent ID", text: $draft.providerID).disabled(draft.originalID != nil)
                TextField("Display name", text: $draft.label)
                TextField("Executable", text: $draft.executable)
                if draft.providerID == "opencode" {
                    Picker("Transport", selection: $draft.transport) {
                        Text("ACP").tag("acp")
                        Text("Automatic (native when supported)").tag("auto")
                        Text("Native").tag("native")
                    }
                }
                AgentSettingsMultiline(title: "Arguments", text: $draft.arguments, hint: "One argument per line. Paths with spaces are a single argument; do not add shell quotes.")
                AgentSettingsMultiline(title: "Environment variables", text: $draft.environment, hint: "One NAME=value per line. These are stored in the daemon’s providers configuration.")
            }.formStyle(.grouped)
            AgentSettingsNotice(error: error)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(busy ? "Saving…" : "Save agent") {
                    busy = true
                    Task {
                        do { _ = try draft.entry(); try await save(draft); dismiss() }
                        catch { self.error = error.localizedDescription; busy = false }
                    }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(!draft.valid || busy)
            }
        }.padding(22).frame(width: 600, height: 590).disabled(busy)
    }
}

struct NativeAgentsSettingsView: View {
    let store: AppStore
    @State private var overview: JSON?
    @State private var error: String?
    @State private var message: String?
    @State private var busy = false
    @State private var editor: AgentSettingsProviderDraft?
    @State private var removeID: String?

    private let recommended: [(id: String, label: String, command: [String], transport: String, setup: String)] = [
        ("cursor", "Cursor", ["cursor-agent", "acp"], "acp", "curl -fsSL https://cursor.com/install | bash"),
        ("opencode", "OpenCode", ["opencode", "acp"], "auto", "curl -fsSL https://opencode.ai/v2/install | bash"),
        ("pi", "Pi", ["pi-acp"], "acp", "npm install -g --ignore-scripts @earendil-works/pi-coding-agent pi-acp"),
        ("hermes", "Hermes", ["hermes", "acp"], "acp", "hermes model"),
        ("unreal", "Unreal Agent", ["falcondeck-unreal-agent-acp"], "acp", "go install github.com/unreallabsai/unreal-agent/cmd/unreal-agent-runner@latest")
    ]

    var body: some View {
        Form {
            Section {
                Text("Use the built-in coding agents or add any command that supports the Agent Client Protocol. Changes apply to new sessions without restarting.").foregroundStyle(.secondary)
                AgentSettingsNotice(error: error, message: message)
                Button("Reload agents", systemImage: "arrow.clockwise") { Task { await load() } }.disabled(busy)
            }
            if let project = store.selectedProject {
                Section("Status in \(project.name)") {
                    ForEach(project.raw["agents"].array, id: \.self) { agent in
                        LabeledContent(agent["label"].string.isEmpty ? agent["provider"].string.capitalized : agent["label"].string) {
                            VStack(alignment: .trailing) {
                                Text(agent["account"]["label"].string)
                                Text("\(agent["models"].array.count) models · \(agent["account"]["status"].string.replacingOccurrences(of: "_", with: " "))").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if !project.raw["last_error"].string.isEmpty { Text(project.raw["last_error"].string).foregroundStyle(.red).textSelection(.enabled) }
                }
            }
            Section("Built in") {
                LabeledContent("Codex", value: "OpenAI Codex CLI")
                LabeledContent("Claude", value: "Claude Code CLI")
                LabeledContent("Antigravity", value: "Google Antigravity CLI")
                Text("Install, repair and check sign-in in Harnesses.").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
            }
            Section("Recommended agents") {
                ForEach(recommended, id: \.id) { agent in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(agent.label).font(NativePreferences.shared.font(size: 14, weight: .semibold))
                            Text(agent.command.joined(separator: " ")).font(NativePreferences.shared.font(size: 11, surface: "code")).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if configured(agent.id) {
                            Label("Configured", systemImage: "checkmark.circle").foregroundStyle(.secondary)
                        } else {
                            Button("Configure") {
                                Task {
                                    do {
                                        try await write { $0[agent.id] = .object(["label": .string(agent.label), "command": .array(agent.command.map(JSON.string)), "transport": .string(agent.transport)]) }
                                        message = "\(agent.label) configured. Install its CLI in Harnesses if needed."
                                    } catch { self.error = error.localizedDescription }
                                }
                            }.disabled(overview == nil || busy)
                        }
                        Button("Copy setup", systemImage: "doc.on.doc") { agentSettingsCopy(agent.setup); message = "Setup command copied." }
                            .labelStyle(.iconOnly).help(agent.setup)
                    }
                }
            }
            Section("Configured ACP agents") {
                if overview == nil && error == nil { ProgressView("Loading agents…") }
                else if overview?["resolved"].array.isEmpty == true { Text("No ACP agents configured.").foregroundStyle(.secondary) }
                ForEach(overview?["resolved"].array ?? [], id: \.self) { agent in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(agent["label"].string.isEmpty ? agent["id"].string : agent["label"].string).font(NativePreferences.shared.font(size: 14, weight: .semibold))
                            Text(agent["command"].array.map(\.string).joined(separator: " ")).font(NativePreferences.shared.font(size: 11, surface: "code")).foregroundStyle(.secondary).textSelection(.enabled)
                            Text(agent["malformed"].bool ? "Invalid configuration" : agent["binary_found"].bool ? "Installed" : "Executable not found")
                                .font(NativePreferences.shared.font(size: 11)).foregroundStyle(agent["binary_found"].bool ? Color.secondary : Color.orange)
                        }
                        Spacer()
                        Button("Edit") { editor = AgentSettingsProviderDraft(providerID: agent["id"].string, entry: overview?["providers"][agent["id"].string] ?? .null) }
                        Button("Remove", systemImage: "trash", role: .destructive) { removeID = agent["id"].string }.labelStyle(.iconOnly)
                    }.disabled(busy)
                }
                Button("Add ACP agent", systemImage: "plus") { editor = AgentSettingsProviderDraft() }.disabled(overview == nil || busy)
            }
        }.formStyle(.grouped)
            .task { await load() }
            .sheet(item: $editor) { draft in
                AgentSettingsProviderEditor(draft: draft) { next in
                    let id = next.providerID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    if next.originalID == nil && configured(id) { throw PilotError("An agent with that ID is already configured.") }
                    let entry = try next.entry()
                    try await write { $0[id] = entry }
                    message = "Agent saved."
                }
            }
            .confirmationDialog("Remove \(removeID ?? "agent")?", isPresented: Binding(get: { removeID != nil }, set: { if !$0 { removeID = nil } })) {
                Button("Remove agent", role: .destructive) {
                    guard let id = removeID else { return }
                    Task { do { try await write { $0.removeValue(forKey: id) }; message = "Agent removed." } catch { self.error = error.localizedDescription } }
                    removeID = nil
                }
            } message: { Text("Existing conversations keep their history. This agent will no longer be available for new sessions.") }
    }

    private func configured(_ id: String) -> Bool { agentSettingsFields(overview?["providers"] ?? .null)[id] != nil }

    @MainActor private func load() async {
        busy = true; error = nil
        defer { busy = false }
        do { overview = try await store.request("/api/providers") }
        catch { self.error = error.localizedDescription }
    }

    @MainActor private func write(_ mutate: (inout [String: JSON]) -> Void) async throws {
        guard !busy, let overview else { throw PilotError("Wait for the agents to finish loading, then try again.") }
        busy = true; error = nil
        defer { busy = false }
        var providers = agentSettingsFields(overview["providers"])
        mutate(&providers)
        do {
            _ = try await store.request("/api/providers", method: "PUT", body: .object(["providers": .object(providers), "expected_revision": overview["revision"]]))
            self.overview = try await store.request("/api/providers")
        } catch {
            self.overview = try? await store.request("/api/providers")
            throw error
        }
    }
}

struct NativeHarnessesSettingsView: View {
    let store: AppStore
    @AppStorage("native.harnesses.sshTarget") private var target = ""
    @AppStorage("native.harnesses.sshPort") private var port = ""
    @AppStorage("native.harnesses.activeJob") private var activeJob = ""
    @State private var overview: JSON?
    @State private var loadedTarget = ""
    @State private var loadedPort = ""
    @State private var error: String?
    @State private var message: String?
    @State private var refreshing = false
    @State private var starting = false
    @AppStorage("native.harnesses.upgradeQueue") private var queueStorage = ""
    @State private var job: JSON?
    @State private var outcomes: [String] = []
    @State private var loadIdentity = UUID()
    @State private var showDetails = false
    private var queue: [JSON] {
        get { (try? JSON.decode(Data(queueStorage.utf8)))?.array ?? [] }
        nonmutating set { queueStorage = (try? String(decoding: JSON.array(newValue).data(), as: UTF8.self)) ?? "" }
    }
    private var locked: Bool { refreshing || starting || !activeJob.isEmpty }
    private var hostSelection: Binding<String> {
        Binding(get: {
            if target.isEmpty { return "local" }
            return NativeHostManager.shared.hosts.first { $0.sshTarget == target && ($0.sshPort.map(String.init) ?? "") == port }?.id ?? "manual"
        }, set: { value in
            if value == "local" { target = ""; port = "" }
            else if let host = NativeHostManager.shared.hosts.first(where: { $0.id == value }), let ssh = host.sshTarget {
                target = ssh; port = host.sshPort.map(String.init) ?? ""
            } else { return }
            Task { await load(deep: !target.isEmpty) }
        })
    }
    private var current: Bool { loadedTarget == target && loadedPort == port && overview != nil }
    private var harnesses: [JSON] { current ? overview?["harnesses"].array ?? [] : [] }

    var body: some View {
        Form {
            Section {
                Text("Check coding CLIs on this Mac or an SSH server, repair broken installations and manage updates. Installer commands come from the daemon’s curated registry.").foregroundStyle(.secondary)
                AgentSettingsNotice(error: error, message: message)
            }
            Section("Computer") {
                Picker("Host", selection: hostSelection) {
                    Text("This Mac").tag("local")
                    ForEach(NativeHostManager.shared.hosts.filter { $0.sshTarget != nil }) { host in
                        Text(host.name).tag(host.id)
                    }
                    if !target.isEmpty && !NativeHostManager.shared.hosts.contains(where: { $0.sshTarget == target && ($0.sshPort.map(String.init) ?? "") == port }) {
                        Text("Custom SSH target").tag("manual")
                    }
                }
                TextField("SSH target", text: $target, prompt: Text("Blank for this Mac; alias or user@host"))
                TextField("SSH port", text: $port, prompt: Text("Default"))
                Text(target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Managing this Mac" : "Managing \(target)").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
            }.disabled(locked)
            Section {
                HStack {
                    Button(refreshing ? "Checking…" : "Check for updates", systemImage: "arrow.clockwise") { Task { await load(deep: true) } }.disabled(locked)
                    Button("Upgrade all", systemImage: "arrow.down.circle") { upgradeAll() }
                        .disabled(locked || !current || upgradeable.isEmpty)
                    if refreshing { ProgressView().controlSize(.small) }
                }
            }
            if !activeJob.isEmpty || job != nil {
                Section("Installation progress") {
                    HStack {
                        if !activeJob.isEmpty { ProgressView().controlSize(.small) }
                        Text(job?["label"].string.isEmpty == false ? job!["label"].string : "Updating harness")
                        Spacer()
                        Text(job?["status"].string ?? "running").foregroundStyle(.secondary)
                    }
                    if !queue.isEmpty { Text("\(queue.count) more queued").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary) }
                    ForEach(Array(outcomes.enumerated()), id: \.offset) { _, outcome in
                        Text(outcome).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    DisclosureGroup("Upgrade details", isExpanded: $showDetails) {
                        ScrollView {
                            Text((job?["log"].array.map(\.string) ?? []).joined(separator: "\n"))
                                .font(NativePreferences.shared.font(size: 11, surface: "code")).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }.frame(minHeight: 100, maxHeight: 240)
                    }
                    if job?["error"].string.isEmpty == false { Text(job!["error"].string).foregroundStyle(.red).textSelection(.enabled) }
                }
            }
            Section("Harnesses") {
                if overview == nil && error == nil { ProgressView("Probing harnesses…") }
                if !current && !refreshing {
                    Text("Check for updates to load this computer’s harnesses.").foregroundStyle(.secondary)
                }
                ForEach(harnesses, id: \.self) { harness in
                    harnessRow(harness)
                }
            }
        }.formStyle(.grouped)
            .task(id: activeJob) {
                let id = activeJob
                await load(deep: !target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                guard !Task.isCancelled else { return }
                if !id.isEmpty { await poll(id) }
            }
    }

    private var upgradeable: [JSON] {
        harnesses.filter { $0["installed"].bool && !$0["upgrade_command"].string.isEmpty && ($0["update_available"] != .bool(false) || $0["install_state"].string == "broken") }
    }

    @ViewBuilder private func harnessRow(_ harness: JSON) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Image(systemName: "terminal").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(harness["label"].string).font(NativePreferences.shared.font(size: 14, weight: .semibold))
                    Text(status(harness)).font(NativePreferences.shared.font(size: 11)).foregroundStyle(harness["install_state"].string == "broken" ? Color.red : Color.secondary)
                    if !harness["account_status"].string.isEmpty { Text(harness["account_status"].string).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary) }
                }
                Spacer()
                if !harness["version"].string.isEmpty { Text("v\(harness["version"].string)").font(NativePreferences.shared.font(size: 11, surface: "code")).foregroundStyle(.secondary) }
                if !harness["upgrade_command"].string.isEmpty {
                    Button(!harness["installed"].bool ? "Install" : harness["install_state"].string == "broken" ? "Repair" : "Upgrade") {
                        Task { await start(harness) }
                    }.disabled(locked)
                }
            }
            if !harness["resolved_path"].string.isEmpty {
                Text("Using \(harness["resolved_path"].string)").font(NativePreferences.shared.font(size: 11, surface: "code")).foregroundStyle(.secondary).textSelection(.enabled)
            }
            ForEach(harness["extra_installs"].array, id: \.self) { copy in
                Text("Also found \(copy["path"].string)\(copy["version"].string.isEmpty ? "" : " · v" + copy["version"].string) — not used")
                    .font(NativePreferences.shared.font(size: 11)).foregroundStyle(.orange).textSelection(.enabled)
            }
            if !harness["failure"].string.isEmpty { Text(harness["failure"].string).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.red).textSelection(.enabled) }
            if let command = signInCommand(harness), harness["auth_verdict"].string != "authenticated", harness["installed"].bool, harness["install_state"].string != "broken" {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Run in Terminal on \(target.isEmpty ? "this Mac" : target), then check sign-in.").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                    Text(command).font(NativePreferences.shared.font(size: 11, surface: "code")).textSelection(.enabled)
                    HStack {
                        Button("Copy sign-in command", systemImage: "doc.on.doc") { agentSettingsCopy(command); message = "Sign-in command copied." }
                        Button("Check sign-in") { Task { await load(deep: true, latest: false) } }.disabled(locked)
                    }
                }
            }
        }.padding(.vertical, 5)
    }

    private func status(_ harness: JSON) -> String {
        if !harness["installed"].bool { return "Not installed" }
        if harness["install_state"].string == "broken" { return "Needs repair" }
        if harness["auth_verdict"].string == "unauthenticated" { return "Sign-in required" }
        if harness["update_available"].bool { return "Out of date · Latest v\(harness["latest_version"].string)" }
        if harness["update_available"] == .bool(false) { return "Up to date" }
        return "Installed · Latest version unknown"
    }

    private func signInCommand(_ harness: JSON) -> String? {
        let id = harness["id"].string
        guard id == "codex" || id == "claude" else { return nil }
        let raw = harness["resolved_path"].string.isEmpty ? harness["bin"].string : harness["resolved_path"].string
        let escaped = "'" + raw.replacingOccurrences(of: "'", with: "'\\''") + "'"
        return escaped + (id == "codex" ? " login" : " auth login")
    }

    private func hostBody() throws -> [String: JSON] {
        let clean = target.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanPort = port.trimmingCharacters(in: .whitespacesAndNewlines)
        var result: [String: JSON] = [:]
        if !clean.isEmpty {
            result["ssh_target"] = .string(clean)
            if !cleanPort.isEmpty {
                guard let value = Int(cleanPort), (1...65535).contains(value) else { throw PilotError("Enter a valid SSH port from 1 to 65535.") }
                result["port"] = .number(Double(value))
            }
        }
        return result
    }

    @MainActor private func load(deep: Bool, latest: Bool = true) async {
        guard !refreshing else { return }
        let identity = UUID(); loadIdentity = identity
        let selection = target; let selectedPort = port
        refreshing = true; error = nil
        defer { if loadIdentity == identity { refreshing = false } }
        do {
            var fields = try hostBody()
            fields["include_latest"] = .bool(latest)
            let result = try await store.request(deep ? "/api/harnesses/refresh" : "/api/harnesses", method: deep ? "POST" : "GET", body: deep ? .object(fields) : nil)
            guard loadIdentity == identity, selection == target, selectedPort == port, !Task.isCancelled else { return }
            overview = result; loadedTarget = selection; loadedPort = selectedPort
        } catch is CancellationError { }
        catch { if loadIdentity == identity { self.error = error.localizedDescription } }
    }

    @MainActor private func start(_ harness: JSON, replacingJob: String? = nil) async {
        guard !starting, (activeJob.isEmpty || activeJob == replacingJob), !refreshing, (current || replacingJob != nil) else { return }
        starting = true; error = nil
        if replacingJob == nil { outcomes = [] }
        defer { starting = false }
        do {
            var fields = try hostBody(); fields["harness_id"] = harness["id"]
            let result = try await store.request("/api/harnesses/upgrade", method: "POST", body: .object(fields))
            let id = result["job_id"].string
            guard !id.isEmpty else { throw PilotError("The daemon did not return an installation job.") }
            job = .object(["label": harness["label"], "status": .string("running"), "log": .array([])])
            activeJob = id
        } catch { self.error = error.localizedDescription; queue = [] }
    }

    @MainActor private func upgradeAll() {
        guard !locked, let first = upgradeable.first else { return }
        queue = Array(upgradeable.dropFirst())
        Task { await start(first) }
    }

    @MainActor private func poll(_ id: String) async {
        while !Task.isCancelled && activeJob == id {
            do {
                let result = try await store.request("/api/harnesses/jobs/" + agentSettingsEncoded(id))
                guard !Task.isCancelled, activeJob == id else { return }
                guard ["running", "completed", "failed"].contains(result["status"].string) else { throw PilotError("The daemon returned an invalid installation status.") }
                job = result; error = nil
                if result["status"].string != "running" {
                    await load(deep: true, latest: false)
                    guard !Task.isCancelled, activeJob == id else { return }
                    if result["status"].string == "failed" {
                        let detail = result["error"].string.isEmpty ? "The installation failed. See upgrade details." : result["error"].string
                        error = detail; outcomes.append("\(result["label"].string): \(detail)")
                    } else {
                        message = "\(result["label"].string) updated."
                        outcomes.append("\(result["label"].string): updated")
                    }
                    if let next = queue.first {
                        queue.removeFirst()
                        await start(next, replacingJob: id)
                        if activeJob == id { activeJob = "" }
                    } else { activeJob = "" }
                    return
                }
            } catch is CancellationError { return }
            catch {
                guard !Task.isCancelled, activeJob == id else { return }
                let detail = error.localizedDescription
                if detail.contains("404") || detail.localizedCaseInsensitiveContains("not found") || detail.localizedCaseInsensitiveContains("unknown harness job:") {
                    activeJob = ""; queue = []
                    self.error = "The daemon no longer has this installation job. It may have restarted. Check the harness version before starting another installation."
                    return
                }
                self.error = "Waiting for the installation status: \(detail)"
            }
            do { try await Task.sleep(for: .milliseconds(1500)) } catch { return }
        }
    }
}

private struct AgentSettingsConnector: Identifiable {
    var name: String
    var entry: JSON
    var inherited: Bool
    var id: String { (inherited ? "global:" : "local:") + name }
    var enabled: Bool { entry["enabled"] != .bool(false) }
}

private struct AgentSettingsConnectorDraft: Identifiable {
    var id = UUID()
    var originalName: String?
    var name = ""
    var mode = "command"
    var executable = ""
    var arguments = ""
    var url = ""
    var environment = ""
    var headers = ""
    var providers = ""
    var enabled = true
    var original: JSON = .object([:])

    init() {}
    init(connector: AgentSettingsConnector) {
        originalName = connector.name; name = connector.name; original = connector.entry
        executable = connector.entry["command"].string
        arguments = connector.entry["args"].array.map(\.string).joined(separator: "\n")
        url = connector.entry["url"].string
        mode = url.isEmpty ? "command" : "url"
        environment = agentSettingsPairText(connector.entry["env"])
        headers = agentSettingsPairText(connector.entry["headers"], separator: ": ")
        providers = connector.entry["providers"].array.map(\.string).joined(separator: ", ")
        enabled = connector.enabled
    }

    var valid: Bool {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if mode == "command" { return !executable.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard let components = URLComponents(string: url.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
        return ["http", "https"].contains(components.scheme?.lowercased() ?? "") && components.host?.isEmpty == false
    }

    func entry() throws -> JSON {
        var fields = agentSettingsFields(original)
        fields["enabled"] = .bool(enabled)
        let filters = providers.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        fields["providers"] = .array(filters.map(JSON.string))
        if mode == "command" {
            fields["command"] = .string(executable.trimmingCharacters(in: .whitespacesAndNewlines))
            fields["args"] = .array(agentSettingsLines(arguments).map(JSON.string))
            fields["env"] = try agentSettingsPairs(environment)
            fields.removeValue(forKey: "url"); fields.removeValue(forKey: "headers")
        } else {
            fields["url"] = .string(url.trimmingCharacters(in: .whitespacesAndNewlines))
            fields["headers"] = try agentSettingsPairs(headers, separator: ":")
            fields.removeValue(forKey: "command"); fields.removeValue(forKey: "args"); fields.removeValue(forKey: "env")
        }
        return .object(fields)
    }
}

private struct AgentSettingsConnectorEditor: View {
    @State var draft: AgentSettingsConnectorDraft
    let scope: String
    var save: (AgentSettingsConnectorDraft) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(draft.originalName == nil ? "Add MCP server" : "Edit MCP server").font(NativePreferences.shared.font(size: 22, weight: .bold))
            Text("Saving to \(scope)").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
            Form {
                TextField("Name", text: $draft.name)
                Picker("Connection", selection: $draft.mode) {
                    Text("Command").tag("command")
                    Text("HTTP URL").tag("url")
                }.pickerStyle(.segmented)
                if draft.mode == "command" {
                    TextField("Executable", text: $draft.executable)
                    AgentSettingsMultiline(title: "Arguments", text: $draft.arguments, hint: "One argument per line; no shell quoting.")
                    AgentSettingsMultiline(title: "Environment variables", text: $draft.environment, hint: "One NAME=value per line.")
                } else {
                    TextField("Server URL", text: $draft.url, prompt: Text("https://example.com/mcp"))
                    AgentSettingsMultiline(title: "HTTP headers", text: $draft.headers, hint: "One Header-Name: value per line.")
                }
                TextField("Restrict to agents", text: $draft.providers, prompt: Text("Blank for all; e.g. codex, claude"))
                Toggle("Enabled", isOn: $draft.enabled)
            }.formStyle(.grouped)
            AgentSettingsNotice(error: error)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(busy ? "Saving…" : "Save server") {
                    busy = true
                    Task {
                        do { _ = try draft.entry(); try await save(draft); dismiss() }
                        catch { self.error = error.localizedDescription; busy = false }
                    }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(!draft.valid || busy)
            }
        }.padding(22).frame(width: 620, height: 650).disabled(busy)
    }
}

private struct AgentSettingsConnectorImport: View {
    var save: ([String: JSON]) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Import MCP servers").font(NativePreferences.shared.font(size: 22, weight: .bold))
            Text("Paste a standard mcpServers configuration or a name-to-server map. Imported names replace matching entries in the selected scope.").font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
            AgentSettingsMultiline(title: "MCP configuration", text: $text, height: 240)
            AgentSettingsNotice(error: error)
            HStack {
                Button("Paste") { if let value = NSPasteboard.general.string(forType: .string) { text = value } }
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(busy ? "Importing…" : "Import") {
                    busy = true
                    Task {
                        do {
                            let parsed = try JSON.decode(Data(text.utf8))
                            let map = parsed["mcpServers"] == .null ? parsed : parsed["mcpServers"]
                            guard case .object(let entries) = map, !entries.isEmpty else { throw PilotError("Enter an object containing one or more MCP server entries.") }
                            for (name, entry) in entries {
                                guard case .object = entry, !name.isEmpty, !entry["command"].string.isEmpty || !entry["url"].string.isEmpty else {
                                    throw PilotError("Server ‘\(name)’ needs a command or URL.")
                                }
                            }
                            try await save(entries); dismiss()
                        } catch { self.error = error.localizedDescription; busy = false }
                    }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
            }
        }.padding(22).frame(width: 650).disabled(busy)
    }
}

struct NativeConnectorsSettingsView: View {
    let store: AppStore
    @State private var scope = "global"
    @State private var loadedScope: String?
    @State private var overview: JSON?
    @State private var busy = false
    @State private var error: String?
    @State private var message: String?
    @State private var identity = UUID()
    @State private var editor: AgentSettingsConnectorDraft?
    @State private var importing = false
    @State private var remove: AgentSettingsConnector?
    private var ready: Bool { overview != nil && loadedScope == scope && !busy }
    private var scopeName: String { scope == "global" ? "all projects" : store.projects.first { $0.id == scope }?.name ?? "this project" }
    private var rows: [AgentSettingsConnector] {
        guard loadedScope == scope, let overview else { return [] }
        if scope == "global" {
            return agentSettingsFields(overview["global"]).keys.sorted().map { AgentSettingsConnector(name: $0, entry: overview["global"][$0], inherited: false) }
        }
        return overview["merged"].array.map { row in
            var entry = agentSettingsFields(row); entry.removeValue(forKey: "name"); entry.removeValue(forKey: "scope")
            return AgentSettingsConnector(name: row["name"].string, entry: .object(entry), inherited: row["scope"].string == "global")
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        Form {
            Section {
                Text("MCP servers give your agents tools. Global servers are inherited by every project; project entries override matching global names. Changes apply on the next turn.").foregroundStyle(.secondary)
                AgentSettingsNotice(error: error, message: message)
            }
            Section("Configuration scope") {
                Picker("Apply to", selection: $scope) {
                    Text("Global · Every project").tag("global")
                    ForEach(store.projects.filter { $0.raw["kind"].string != "casual" }) { project in
                        Text(project.name).tag(project.id)
                    }
                }.disabled(busy)
                HStack {
                    Button("Add server", systemImage: "plus") { editor = AgentSettingsConnectorDraft() }.disabled(!ready)
                    Button("Import configuration", systemImage: "square.and.arrow.down") { importing = true }.disabled(!ready)
                    Spacer()
                    Button("Reload", systemImage: "arrow.clockwise") { Task { await load() } }.disabled(busy)
                }
            }
            Section("MCP servers") {
                if busy && overview == nil { ProgressView("Loading servers…") }
                else if rows.isEmpty && overview != nil { Text("No servers configured in this scope.").foregroundStyle(.secondary) }
                ForEach(rows) { row in connectorRow(row) }
            }
            Section {
                Text("Global configuration: ~/.falcondeck/connectors.json\nProject configuration: .falcondeck/connectors.json")
                    .font(NativePreferences.shared.font(size: 11, surface: "code")).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }.formStyle(.grouped)
            .task(id: scope) { await load() }
            .sheet(item: $editor) { draft in
                AgentSettingsConnectorEditor(draft: draft, scope: scopeName) { next in
                    let name = next.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    if next.originalName == nil, rows.contains(where: { $0.name == name && !$0.inherited }) { throw PilotError("A server with that name already exists. Edit it to replace its configuration.") }
                    let entry = try next.entry()
                    try await write { entries in
                        if let original = next.originalName, original != name { entries.removeValue(forKey: original) }
                        entries[name] = entry
                    }
                    message = "Server saved for \(scopeName)."
                }
            }
            .sheet(isPresented: $importing) {
                AgentSettingsConnectorImport { imported in
                    try await write { current in for (name, entry) in imported { current[name] = entry } }
                    message = "Imported \(imported.count) server\(imported.count == 1 ? "" : "s")."
                }
            }
            .confirmationDialog("Remove \(remove?.name ?? "server")?", isPresented: Binding(get: { remove != nil }, set: { if !$0 { remove = nil } })) {
                Button("Remove server", role: .destructive) {
                    guard let row = remove else { return }
                    Task {
                        do { try await write { $0.removeValue(forKey: row.name) }; message = "Server removed." }
                        catch { self.error = error.localizedDescription }
                    }
                    remove = nil
                }
            } message: { Text(scope == "global" ? "This removes the server from all projects inheriting this global configuration." : "This removes the project configuration. A global server with the same name will be inherited again.") }
    }

    @ViewBuilder private func connectorRow(_ row: AgentSettingsConnector) -> some View {
        HStack {
            Image(systemName: row.entry["url"].string.isEmpty ? "powerplug" : "network").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(row.name).font(NativePreferences.shared.font(size: 14, weight: .semibold))
                    if row.inherited { Text("Inherited").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary) }
                }
                Text(row.entry["url"].string.isEmpty ? ([row.entry["command"].string] + row.entry["args"].array.map(\.string)).joined(separator: " ") : row.entry["url"].string)
                    .font(NativePreferences.shared.font(size: 11, surface: "code")).lineLimit(2).foregroundStyle(.secondary).textSelection(.enabled)
                if !row.entry["providers"].array.isEmpty {
                    Text("\(row.entry["providers"].array.map(\.string).joined(separator: ", ")) only").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Toggle("Enable \(row.name)", isOn: Binding(get: { row.enabled }, set: { enabled in
                Task {
                    do { try await write { $0[row.name] = row.entry.setting("enabled", .bool(enabled)) } }
                    catch { self.error = error.localizedDescription }
                }
            })).labelsHidden().help(row.inherited ? "Creates an override for this project" : "Enable or disable server")
            Button(row.inherited ? "Override" : "Edit") { editor = AgentSettingsConnectorDraft(connector: row) }
            if !row.inherited {
                Button("Remove", systemImage: "trash", role: .destructive) { remove = row }.labelStyle(.iconOnly)
            }
        }.disabled(!ready).padding(.vertical, 3)
    }

    @MainActor private func load() async {
        let generation = UUID(); identity = generation
        let selection = scope
        overview = nil; loadedScope = nil; error = nil; busy = true
        defer { if identity == generation { busy = false } }
        do {
            let query = selection == "global" ? "" : "?workspace_id=" + agentSettingsEncoded(selection)
            let result = try await store.request("/api/connectors" + query)
            guard !Task.isCancelled, identity == generation, scope == selection else { return }
            overview = result; loadedScope = selection
        } catch is CancellationError { }
        catch { if identity == generation { self.error = error.localizedDescription } }
    }

    @MainActor private func write(_ mutate: (inout [String: JSON]) -> Void) async throws {
        guard ready, let overview else { throw PilotError("Wait for this scope to load before making changes.") }
        let selection = scope
        busy = true; error = nil
        defer { busy = false }
        var current = agentSettingsFields(overview[selection == "global" ? "global" : "workspace"])
        mutate(&current)
        var body: [String: JSON] = ["scope": .string(selection == "global" ? "global" : "workspace"), "mcpServers": .object(current)]
        if selection != "global" { body["workspace_id"] = .string(selection) }
        _ = try await store.request("/api/connectors", method: "PUT", body: .object(body))
        let query = selection == "global" ? "" : "?workspace_id=" + agentSettingsEncoded(selection)
        self.overview = nil; loadedScope = nil
        let result = try await store.request("/api/connectors" + query)
        if scope == selection { self.overview = result; loadedScope = selection }
    }
}

private struct AgentSettingsUtilityChoice: Identifiable {
    let provider: String
    var model: String
    var id: String { provider }
}

struct NativeModelsSettingsView: View {
    let store: AppStore
    @State private var key = ""
    @State private var configured: Bool?
    @State private var titleModel = ""
    @State private var titlePrompt = ""
    @State private var utility: [AgentSettingsUtilityChoice] = []
    @State private var busy = false
    @State private var loading = false
    @State private var error: String?
    @State private var message: String?
    private let defaultTitleModel = "openai/gpt-6-luna"
    private let defaultTitlePrompt = "Use 3 to 7 words.\nPrefer concrete task nouns.\nAvoid generic titles like Debugging or Code Help."
    private var validModel: Bool { !titleModel.isEmpty && titleModel.count <= 200 && titleModel.rangeOfCharacter(from: .whitespacesAndNewlines) == nil }

    var body: some View {
        Form {
            Section {
                Text("Keys and small helper models used by FalconDeck features, separate from the agent and model selected in each conversation.").foregroundStyle(.secondary)
                AgentSettingsNotice(error: error, message: message)
            }
            Section("OpenRouter") {
                SecureField(configured == true ? "Replace API key" : "API key", text: $key, prompt: Text("sk-or-v1-…"))
                    .privacySensitive().textContentType(.password)
                HStack {
                    Button("Save key") { Task { await saveKey() } }.disabled(busy || key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if configured == true {
                        Button("Remove key", role: .destructive) { Task { await removeKey() } }.disabled(busy)
                        Label("Key configured", systemImage: "lock.shield").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                    } else if configured == false { Text("No key configured").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary) }
                    else if loading { ProgressView().controlSize(.small) }
                    Spacer()
                    Link("Get a key", destination: URL(string: "https://openrouter.ai/keys")!)
                }
                Text("Stored securely by the daemon on this computer. Paired devices use the key through this Mac and never receive it. Powers cloud speech, rewrite, read-aloud and suggested titles.").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
            }
            Section("Title style") {
                AgentSettingsMultiline(title: "Title instructions", text: $titlePrompt, hint: "Used by both automatic and suggested titles. Maximum 2,000 characters.", height: 100)
                HStack {
                    Button("Save prompt") { Task { await savePreferences(.object(["title_suggestion_prompt": .string(titlePrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? defaultTitlePrompt : titlePrompt)])) } }
                        .disabled(busy || titlePrompt.count > 2000)
                    Button("Reset prompt") { titlePrompt = defaultTitlePrompt; Task { await savePreferences(.object(["title_suggestion_prompt": .string(defaultTitlePrompt)])) } }.disabled(busy)
                }
            }
            Section("Suggest title") {
                TextField("OpenRouter model", text: $titleModel)
                HStack {
                    Button("Save model") { Task { await savePreferences(.object(["title_suggestion_model": .string(titleModel)])) } }.disabled(busy || !validModel)
                    Button("Reset model") { titleModel = defaultTitleModel; Task { await savePreferences(.object(["title_suggestion_model": .string(defaultTitleModel)])) } }.disabled(busy)
                }
                Text("Only sends a short conversation excerpt when you request a title suggestion.").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                if !validModel { Text("Enter a model ID without spaces, up to 200 characters.").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.red) }
            }
            Section("Automatic titles") {
                Text("The first installed, signed-in agent in this order names new conversations using its own subscription. Leave a model blank to use the agent’s default.").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                ForEach(Array(utility.enumerated()), id: \.element.id) { index, choice in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(providerLabel(choice.provider)).font(NativePreferences.shared.font(size: 14, weight: .semibold))
                            Text(agentReady(choice.provider) ? "Signed in" : "Unavailable in this project").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                        }.frame(minWidth: 125, alignment: .leading)
                        TextField("Provider default", text: Binding(get: { utility.first { $0.provider == choice.provider }?.model ?? "" }, set: { value in
                            if let position = utility.firstIndex(where: { $0.provider == choice.provider }) { utility[position].model = value }
                        }))
                        Menu("Models") {
                            Button("Provider default") { setUtilityModel(choice.provider, model: "") }
                            ForEach(agentModels(choice.provider), id: \.self) { model in
                                Button(model["label"].string.isEmpty ? model["id"].string : model["label"].string) { setUtilityModel(choice.provider, model: model["id"].string) }
                            }
                        }.menuStyle(.borderlessButton).fixedSize()
                        Button("Move earlier", systemImage: "arrow.up") { utility.swapAt(index, index - 1) }.labelStyle(.iconOnly).disabled(index == 0 || busy)
                        Button("Move later", systemImage: "arrow.down") { utility.swapAt(index, index + 1) }.labelStyle(.iconOnly).disabled(index == utility.count - 1 || busy)
                    }
                }
                HStack {
                    Button("Save automatic title models") { Task { await saveUtility() } }.disabled(busy)
                    Button("Reset automatic titles") {
                        utility = [AgentSettingsUtilityChoice(provider: "claude", model: "haiku"), .init(provider: "codex", model: ""), .init(provider: "opencode", model: ""), .init(provider: "grok", model: "")]
                        Task { await saveUtility() }
                    }.disabled(busy)
                }
            }
        }.formStyle(.grouped)
            .task {
                hydrate()
                loading = true
                do { configured = try await store.request("/api/speech/openrouter-key")["configured"].bool }
                catch { self.error = error.localizedDescription }
                loading = false
            }
    }

    @MainActor private func hydrate() {
        titleModel = store.preferences["title_suggestion_model"].string
        if titleModel.isEmpty { titleModel = defaultTitleModel }
        titlePrompt = store.preferences["title_suggestion_prompt"].string
        if titlePrompt.isEmpty { titlePrompt = defaultTitlePrompt }
        let configured = store.preferences["utility_models"]
        let order = configured["provider_order"].array.map(\.string)
        let providers = order.isEmpty ? ["claude", "codex", "opencode", "grok"] : order
        var seen: Set<String> = []
        utility = providers.filter { seen.insert($0).inserted }.map { provider in
            let saved = configured["models"].array.first { $0["provider"].string == provider }
            return AgentSettingsUtilityChoice(provider: provider, model: saved?["model_id"].string ?? (provider == "claude" && order.isEmpty ? "haiku" : ""))
        }
    }

    private func providerLabel(_ id: String) -> String {
        ["claude": "Claude Code", "codex": "Codex", "opencode": "OpenCode", "grok": "Grok"][id] ?? id.capitalized
    }
    private func agentModels(_ provider: String) -> [JSON] { store.selectedProject?.raw["agents"].array.first { $0["provider"].string == provider }?["models"].array ?? [] }
    private func agentReady(_ provider: String) -> Bool { store.selectedProject?.raw["agents"].array.first { $0["provider"].string == provider }?["account"]["status"].string == "ready" }
    private func setUtilityModel(_ provider: String, model: String) { if let index = utility.firstIndex(where: { $0.provider == provider }) { utility[index].model = model } }

    @MainActor private func saveKey() async {
        guard !busy else { return }
        busy = true; error = nil; message = nil
        defer { busy = false }
        do {
            let result = try await store.request("/api/speech/openrouter-key", method: "PUT", body: .object(["api_key": .string(key.trimmingCharacters(in: .whitespacesAndNewlines))]))
            configured = result["configured"].bool; key = ""; message = "OpenRouter key saved on this computer."
        } catch { self.error = error.localizedDescription }
    }
    @MainActor private func removeKey() async {
        guard !busy else { return }
        busy = true; error = nil; message = nil
        defer { busy = false }
        do { _ = try await store.request("/api/speech/openrouter-key", method: "DELETE"); configured = false; key = ""; message = "OpenRouter key removed." }
        catch { self.error = error.localizedDescription }
    }
    @MainActor private func saveUtility() async {
        let retainedModels = store.preferences["utility_models"]["models"].array.filter { saved in !utility.contains { $0.provider == saved["provider"].string } }
        let choices: [JSON] = utility.map { .object(["provider": .string($0.provider), "model_id": .string($0.model.trimmingCharacters(in: .whitespacesAndNewlines))]) }
        let body: JSON = .object(["utility_models": .object([
            "provider_order": .array(utility.map { .string($0.provider) }),
            "models": .array(retainedModels + choices)
        ])])
        await savePreferences(body)
    }
    @MainActor private func savePreferences(_ patch: JSON) async {
        guard !busy else { return }
        busy = true; error = nil; message = nil
        defer { busy = false }
        do { try await store.updatePreferences(patch); message = "Preferences saved." }
        catch { self.error = error.localizedDescription }
    }
}
