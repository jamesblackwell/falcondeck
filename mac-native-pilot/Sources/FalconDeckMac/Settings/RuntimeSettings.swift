import AppKit
import ApplicationServices
import CoreGraphics
import SwiftUI

private struct RuntimeSettingsSection<Content: View>: View {
    let title: String
    var detail: String = ""
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(NativePreferences.shared.font(size: 14, weight: .semibold))
                if !detail.isEmpty { Text(detail).font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary) }
            }
            VStack(alignment: .leading, spacing: 12) { content }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}

private struct RuntimeSettingsToggle: View {
    let title: String
    let detail: String
    @Binding var value: Bool

    var body: some View {
        Toggle(isOn: $value) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                Text(detail).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }.toggleStyle(.switch)
    }
}

private struct RuntimeSettingsError: View {
    let message: String?
    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(NativePreferences.shared.font(size: 13)).foregroundStyle(.red).textSelection(.enabled)
        }
    }
}

private func runtimeObject(_ value: JSON) -> [String: JSON] {
    if case .object(let fields) = value { return fields }
    return [:]
}

private func runtimePath(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))) ?? value
}

private func runtimeControlResult(_ value: JSON) throws -> JSON {
    if value["ok"] == .bool(false) {
        let error = value["error"]
        let message = error["suggested_action"].string.isEmpty ? error["message"].string : error["suggested_action"].string
        throw PilotError(message.isEmpty ? "The operation could not be completed." : message)
    }
    return value["data"]
}

struct NativeAgentControlSettingsView: View {
    let store: AppStore
    @State private var settings: JSON = .null
    @State private var audit: [JSON] = []
    @State private var timezone = ""
    @State private var error: String?
    @State private var auditError: String?
    @State private var busy = false

    private var providers: [String] {
        Array(Set(["codex", "claude", "grok", "agy"] + Array(runtimeObject(settings["providers"]).keys))).sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("Let agents discover and control FalconDeck conversationally. Scheduled automations continue running when conversational control is disabled.")
                .foregroundStyle(.secondary)
            RuntimeSettingsError(message: error)
            if settings == .null {
                if busy { ProgressView("Loading agent control…") }
                else { Button("Retry") { Task { await load() } } }
            } else {
                RuntimeSettingsSection(title: "Conversational control", detail: "Changes apply to new agent sessions and are enforced by the daemon on every agent request.") {
                    RuntimeSettingsToggle(title: "Agent control enabled", detail: "Agents can discover and invoke FalconDeck capabilities.", value: binding("enabled"))
                    Divider()
                    ForEach(providers, id: \.self) { provider in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(FDTheme.providerName(provider))
                                Text(settings["providers"][provider] == .null ? "Inherits the global setting" : "Explicit provider override")
                                    .font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Picker("Control for \(provider)", selection: providerBinding(provider)) {
                                Text("Inherit").tag("inherit")
                                Text("Enabled").tag("enabled")
                                Text("Disabled").tag("disabled")
                            }.labelsHidden().frame(width: 130)
                        }
                    }
                    Divider()
                    RuntimeSettingsToggle(title: "Inject FalconDeck agent context", detail: "Adds FalconDeck instructions and the control guide on the next turn or agent process start.", value: binding("inject_agent_context"))
                }
                RuntimeSettingsSection(title: "Scheduling defaults") {
                    HStack {
                        TextField("Default timezone", text: $timezone).textFieldStyle(.roundedBorder)
                        Button("Save") { Task { await save(.object(["default_timezone": .string(timezone.trimmingCharacters(in: .whitespacesAndNewlines))])) } }
                            .disabled(timezone.trimmingCharacters(in: .whitespacesAndNewlines) == settings["default_timezone"].string || TimeZone(identifier: timezone.trimmingCharacters(in: .whitespacesAndNewlines)) == nil)
                    }
                    Text("Use an IANA timezone such as Europe/London.").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                    RuntimeSettingsToggle(title: "Allow elevated automations", detail: "Permit automations that use bypassPermissions or danger-full-access. Elevated automations are badged in the list.", value: binding("allow_elevated_automations"))
                }
                RuntimeSettingsSection(title: "Confirmation preferences", detail: "Applies to agents that surface FalconDeck confirmation prompts.") {
                    RuntimeSettingsToggle(title: "Confirm destructive operations", detail: "Ask before deleting automations and other destructive actions.", value: confirmationBinding("destructive_operations"))
                    Divider()
                    RuntimeSettingsToggle(title: "Confirm sensitive operations", detail: "Ask before settings changes and other sensitive actions.", value: confirmationBinding("sensitive_operations"))
                }
                RuntimeSettingsSection(title: "Recent control changes", detail: "Changes from agents, this interface and the scheduler, newest first.") {
                    RuntimeSettingsError(message: auditError)
                    if audit.isEmpty { Text("No control changes recorded yet.").foregroundStyle(.secondary) }
                    ForEach(Array(audit.enumerated()), id: \.offset) { _, entry in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: entry["result"].string == "success" ? "checkmark.circle" : "exclamationmark.circle")
                                .foregroundStyle(entry["result"].string == "success" ? Color.green : Color.red)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry["summary"].string)
                                Text([entry["context"]["origin"].string, entry["context"]["provider"].string, entry["occurred_at"].string].filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary).textSelection(.enabled)
                            }
                            Spacer(minLength: 0)
                        }
                        if entry != audit.last { Divider() }
                    }
                }
            }
            HStack { Spacer(); Button("Refresh") { Task { await load() } } }
        }
        .disabled(busy)
        .task { await load() }
    }

    private func binding(_ key: String) -> Binding<Bool> {
        Binding(get: { settings[key].bool }, set: { value in Task { await save(.object([key: .bool(value)])) } })
    }

    private func providerBinding(_ provider: String) -> Binding<String> {
        Binding(get: {
            let entry = settings["providers"][provider]
            return entry == .null ? "inherit" : entry["enabled"].bool ? "enabled" : "disabled"
        }, set: { value in
            var overrides = runtimeObject(settings["providers"])
            if value == "inherit" { overrides.removeValue(forKey: provider) }
            else { overrides[provider] = .object(["enabled": .bool(value == "enabled")]) }
            Task { await save(.object(["providers": .object(overrides)])) }
        })
    }

    private func confirmationBinding(_ key: String) -> Binding<Bool> {
        Binding(get: { settings["confirmation_policy"][key].bool }, set: { value in
            var policy = runtimeObject(settings["confirmation_policy"])
            policy[key] = .bool(value)
            Task { await save(.object(["confirmation_policy": .object(policy)])) }
        })
    }

    @MainActor private func load() async {
        guard !busy else { return }
        busy = true; error = nil; auditError = nil
        defer { busy = false }
        do {
            let result = try await store.request("/api/control/get", method: "POST", body: .object(["resource": .string("agent_control.settings")]))
            settings = try runtimeControlResult(result)
            timezone = settings["default_timezone"].string
        } catch { self.error = error.localizedDescription }
        do {
            let result = try await store.request("/api/control/get", method: "POST", body: .object(["resource": .string("control.audit"), "limit": .number(20)]))
            audit = try runtimeControlResult(result).array
        } catch { auditError = "Could not load recent changes. \(error.localizedDescription)" }
    }

    @MainActor private func save(_ patch: JSON) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let result = try await store.request("/api/control/execute", method: "POST", body: .object(["operation": .string("agent_control.settings.update"), "arguments": patch]))
            settings = try runtimeControlResult(result)
            timezone = settings["default_timezone"].string
            let history = try? await store.request("/api/control/get", method: "POST", body: .object(["resource": .string("control.audit"), "limit": .number(20)]))
            if let history { audit = history["data"].array }
        } catch { self.error = error.localizedDescription }
    }
}

struct NativeComputerUseSettingsView: View {
    let store: AppStore
    @State private var status: JSON = .null
    @State private var test: JSON = .null
    @State private var accessibility = false
    @State private var screenRecording = false
    @State private var busy = false
    @State private var error: String?

    private var available: Bool { status != .null && status["available"].bool }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("Let agents click, type and read apps on this Mac in the background. Enable computer use and grant both macOS permissions to FalconDeck.")
                .foregroundStyle(.secondary)
            RuntimeSettingsError(message: error)
            if status == .null {
                if busy { ProgressView("Loading computer use…") }
                else { Button("Retry") { Task { await refresh() } } }
            } else if !available {
                Label("Computer use requires the bundled driver on macOS 14 or later. The connected daemon does not currently provide it.", systemImage: "info.circle")
                    .foregroundStyle(.secondary)
            }
            RuntimeSettingsSection(title: "Agents on this Mac") {
                RuntimeSettingsToggle(title: "Allow agents to use this Mac", detail: "Every harness receives computer-use tools once computer use is enabled and both permissions are granted.", value: binding("enabled"))
                Divider()
                RuntimeSettingsToggle(title: "Show the agent cursor", detail: "A pointer overlay follows agent clicks so you can see what is being controlled.", value: binding("overlay", fallback: true))
                Divider()
                RuntimeSettingsToggle(title: "Share anonymous driver telemetry with Cua", detail: "Shares content-free driver installation metrics. Screen contents are never included.", value: binding("telemetry"))
            }.disabled(!available || busy)
            RuntimeSettingsSection(title: "Signed-in browser access") {
                RuntimeSettingsToggle(title: "Allow agents to use my signed-in browser profile", detail: "Gives trusted agents access to live pages, cookies, storage and signed-in accounts in existing Chrome or Edge sessions.", value: binding("existing_profile"))
                    .disabled(!available || status["existing_profile"] == .null || busy)
                Text("Computer use must also be enabled. Changing this setting restarts the driver and disconnects active sessions. Restart FalconDeck to reconnect agent tools. Turning it off stops FalconDeck access but does not disable Chrome’s remote-debugging setting.")
                    .font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
            }
            RuntimeSettingsSection(title: "macOS permissions", detail: "Grant permissions to the native FalconDeck app. Existing grants to the Tauri app may belong to a different app identity.") {
                permissionRow("Accessibility", detail: "Allows agents to click, type and read other apps without stealing focus.", granted: accessibility, privacy: "Privacy_Accessibility") {
                    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                    _ = AXIsProcessTrustedWithOptions(options)
                    refreshLocalPermissions()
                }
                Divider()
                permissionRow("Screen Recording", detail: "Allows agents to see window contents. macOS calls this Screen & System Audio Recording.", granted: screenRecording, privacy: "Privacy_ScreenCapture") {
                    _ = CGRequestScreenCaptureAccess()
                    refreshLocalPermissions()
                }
                Text("After changing permissions, return here and restart the driver. If captures are blank, quit and reopen FalconDeck so macOS can apply the grant.")
                    .font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
            }
            RuntimeSettingsSection(title: "Driver", detail: status["driver_version"].string.isEmpty ? "The driver starts when an agent first needs it." : "Bundled cua-driver \(status["driver_version"].string)") {
                HStack(spacing: 12) {
                    Label(status["running"].bool ? "Running" : "Stopped", systemImage: status["running"].bool ? "checkmark.circle" : "circle")
                        .foregroundStyle(status["running"].bool ? Color.green : Color.secondary)
                    Spacer()
                    if busy { ProgressView().controlSize(.small) }
                    Button("Test it") { Task { await testDriver() } }.disabled(!available || !status["enabled"].bool || busy)
                    Button("Restart driver") { Task { await restartDriver() } }.disabled(!available || busy)
                }
                if !status["last_error"].string.isEmpty { RuntimeSettingsError(message: status["last_error"].string) }
                if test != .null {
                    Label(test["ok"].bool ? "Computer use is working" : test["black_frame"].bool ? "The capture is blank. Quit and reopen FalconDeck." : test["error"].string, systemImage: test["ok"].bool ? "checkmark.circle.fill" : "exclamationmark.triangle")
                        .foregroundStyle(test["ok"].bool ? Color.green : Color.orange)
                    if let image = testImage { Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 180).clipShape(RoundedRectangle(cornerRadius: 8)) }
                }
                let health = test["health"] == .null ? status["health"] : test["health"]
                ForEach(Array(health["checks"].array.enumerated()), id: \.offset) { _, check in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(check["name"].string).fontWeight(.medium)
                            Spacer()
                            Text(check["status"].string).foregroundStyle(.secondary)
                        }
                        Text(check["message"].string).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                        if !check["hint"].string.isEmpty { Text(check["hint"].string).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary) }
                    }
                }
            }
            HStack { Spacer(); Button("Refresh permissions and status") { Task { await refresh() } }.disabled(busy) }
        }
        .task { await refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in Task { await refresh(restartAfterGrant: true) } }
    }

    private var testImage: NSImage? {
        let url = test["thumbnail_data_url"].string
        guard url.hasPrefix("data:image/"), let content = url.split(separator: ",", maxSplits: 1).last,
              let data = Data(base64Encoded: String(content)) else { return nil }
        return NSImage(data: data)
    }

    private func permissionRow(_ title: String, detail: String, granted: Bool, privacy: String, grant: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                Text(detail).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
            }
            Spacer()
            Text(granted ? "Granted" : "Needed").font(NativePreferences.shared.font(size: 11)).foregroundStyle(granted ? Color.green : Color.orange)
            if !granted { Button("Grant", action: grant) }
            Button("Settings") { if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(privacy)") { NSWorkspace.shared.open(url) } }
        }
    }

    private func binding(_ key: String, fallback: Bool = false) -> Binding<Bool> {
        Binding(get: { status[key] == .null ? fallback : status[key].bool }, set: { value in Task { await update(.object([key: .bool(value)])) } })
    }

    @MainActor private func refreshLocalPermissions() {
        accessibility = AXIsProcessTrusted()
        screenRecording = CGPreflightScreenCaptureAccess()
    }

    @MainActor private func refresh(restartAfterGrant: Bool = false) async {
        guard !busy else { return }
        let wasGranted = accessibility && screenRecording
        refreshLocalPermissions()
        busy = true; error = nil
        defer { busy = false }
        do {
            status = try await store.request("/api/computer-use")
            if restartAfterGrant && !wasGranted && accessibility && screenRecording && status["enabled"].bool {
                status = try await store.request("/api/computer-use/restart", method: "POST")
            }
        } catch { self.error = error.localizedDescription }
    }

    @MainActor private func update(_ patch: JSON) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { status = try await store.request("/api/computer-use", method: "POST", body: patch) }
        catch { self.error = error.localizedDescription }
    }

    @MainActor private func restartDriver() async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { status = try await store.request("/api/computer-use/restart", method: "POST") }
        catch { self.error = error.localizedDescription }
    }

    @MainActor private func testDriver() async {
        guard !busy else { return }
        busy = true; error = nil; test = .null
        defer { busy = false }
        do {
            test = try await store.request("/api/computer-use/test", method: "POST")
            status = try await store.request("/api/computer-use")
        } catch { self.error = error.localizedDescription }
    }
}

private struct RuntimeExtensionEnableRequest: Identifiable {
    let id: String
    let name: String
    let permissions: [String]
}

private func runtimePermissionCopy(_ permission: String) -> (String, String) {
    switch permission {
    case "threads:read": return ("Read task summaries", "Read titles, providers, status, timestamps and pending-request counts. Messages and transcripts stay private.")
    case "agent-tools:register": return ("Offer tools to agents", "Publish the extension’s declared tools to agents running in FalconDeck.")
    case "automations:manage-owned": return ("Manage owned automations", "Create and control this extension’s scheduled tasks. Other automations are inaccessible.")
    default: return (permission, "Requested extension capability.")
    }
}

struct NativeExtensionsSettingsView: View {
    let store: AppStore
    @State private var catalog: [JSON] = []
    @State private var query = ""
    @State private var busy = false
    @State private var loaded = false
    @State private var error: String?
    @State private var enableRequest: RuntimeExtensionEnableRequest?

    private var filtered: [JSON] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return catalog.filter {
            query.isEmpty || [$0["name"].string, $0["id"].string, $0["source"].string, $0["bundled"].bool ? "official" : ""].contains { $0.localizedCaseInsensitiveContains(query) }
        }.sorted {
            if $0["enabled"].bool != $1["enabled"].bool { return $0["enabled"].bool }
            return $0["name"].string.localizedStandardCompare($1["name"].string) == .orderedAscending
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Manage extensions installed on this FalconDeck. Official extensions are built and maintained by FalconDeck.").foregroundStyle(.secondary)
            HStack {
                TextField("Search installed extensions", text: $query).textFieldStyle(.roundedBorder)
                Button("Refresh") { Task { await load() } }.disabled(busy)
            }
            RuntimeSettingsError(message: error)
            if busy && !loaded { ProgressView("Loading extensions…") }
            if loaded && filtered.isEmpty {
                Text(catalog.isEmpty ? "No extensions are installed." : "No installed extensions match your search.").foregroundStyle(.secondary).padding(.vertical, 20)
            }
            ForEach(filtered, id: \.self) { item in extensionCard(item) }
        }
        .task { await load() }
        .sheet(item: $enableRequest) { request in
            VStack(alignment: .leading, spacing: 20) {
                Text("Enable \(request.name)?").font(NativePreferences.shared.font(size: 22)).fontWeight(.semibold)
                Text("This extension needs the following permissions before it can run.").foregroundStyle(.secondary)
                ForEach(request.permissions, id: \.self) { permission in
                    let copy = runtimePermissionCopy(permission)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(copy.0).fontWeight(.medium)
                        Text(copy.1).font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
                    }
                }
                RuntimeSettingsError(message: error)
                HStack {
                    Spacer()
                    Button("Cancel") { enableRequest = nil; error = nil }.keyboardShortcut(.cancelAction)
                    Button("Allow and enable") { Task { await allowAndEnable(request) } }.keyboardShortcut(.defaultAction)
                }.disabled(busy)
            }.padding(28).frame(width: 480)
        }
    }

    private func extensionCard(_ item: JSON) -> some View {
        let id = item["id"].string
        let name = item["name"].string
        let enabled = item["enabled"].bool
        return RuntimeSettingsSection(title: name, detail: "\(id) · v\(item["version"].string) · \(item["source"].string)") {
            HStack(spacing: 10) {
                if item["bundled"].bool { Label("Official", systemImage: "checkmark.seal").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary) }
                Text(item["status"].string).font(NativePreferences.shared.font(size: 11)).foregroundStyle(item["status"].string == "error" ? Color.red : enabled ? Color.green : Color.secondary)
                Spacer()
                Button(enabled ? "Disable" : "Enable") {
                    let granted = Set(item["granted_permissions"].array.map(\.string))
                    let missing = item["permissions"].array.map(\.string).filter { !granted.contains($0) }
                    if !enabled && !missing.isEmpty {
                        error = nil
                        enableRequest = RuntimeExtensionEnableRequest(id: id, name: name, permissions: missing)
                    } else { Task { await setEnabled(id, enabled: !enabled) } }
                }.disabled(busy)
            }
            ForEach(item["permissions"].array.map(\.string), id: \.self) { permission in
                let granted = item["granted_permissions"].array.contains(.string(permission))
                let copy = runtimePermissionCopy(permission)
                Divider()
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(copy.0)
                        Text(copy.1).font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                        Text(permission).font(NativePreferences.shared.font(size: 11, surface: "code")).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Button(granted ? "Revoke" : "Grant") { Task { await setPermission(id, permission: permission, granted: !granted) } }.disabled(busy)
                }
            }
            if !item["last_error"].string.isEmpty { RuntimeSettingsError(message: item["last_error"].string) }
            let unsupported = item["contributes"]["unsupported"].array.map { $0["kind"].string }.filter { !$0.isEmpty }
            if !unsupported.isEmpty {
                Label("This client cannot render: \(unsupported.joined(separator: ", ")).", systemImage: "info.circle")
                    .font(NativePreferences.shared.font(size: 11)).foregroundStyle(.orange)
            }
        }
    }

    @MainActor private func load() async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { catalog = try await store.request("/api/extensions")["catalog"].array; loaded = true }
        catch { self.error = error.localizedDescription }
    }

    private func replace(_ item: JSON) {
        if let index = catalog.firstIndex(where: { $0["id"] == item["id"] }) { catalog[index] = item }
    }

    @MainActor private func setEnabled(_ id: String, enabled: Bool) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { replace(try await store.request("/api/extensions/\(runtimePath(id))", method: "PATCH", body: .object(["enabled": .bool(enabled)]))) }
        catch { self.error = error.localizedDescription }
    }

    @MainActor private func setPermission(_ id: String, permission: String, granted: Bool) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { replace(try await store.request("/api/extensions/\(runtimePath(id))/permissions", method: "PATCH", body: .object(["permission": .string(permission), "granted": .bool(granted)]))) }
        catch { self.error = error.localizedDescription }
    }

    @MainActor private func allowAndEnable(_ request: RuntimeExtensionEnableRequest) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            for permission in request.permissions {
                replace(try await store.request("/api/extensions/\(runtimePath(request.id))/permissions", method: "PATCH", body: .object(["permission": .string(permission), "granted": .bool(true)])))
            }
            replace(try await store.request("/api/extensions/\(runtimePath(request.id))", method: "PATCH", body: .object(["enabled": .bool(true)])))
            enableRequest = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct NativeGeneralSettingsView: View {
    let store: AppStore
    @State private var updater = NativeUpdateController.shared
    @State private var preferencesError: String?
    @State private var showWelcome = false
    @State private var resetWelcome = false

    private var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            RuntimeSettingsSection(title: "Startup", detail: "Pick up where your agents left off.") {
                RuntimeSettingsToggle(title: "Automatically continue stopped sessions", detail: "Continue sessions interrupted when FalconDeck closed, using their saved agent and permissions.", value: Binding(get: { store.preferences["auto_resume_interrupted_sessions"].bool }, set: { value in
                    Task {
                        preferencesError = nil
                        do { try await store.updatePreferences(.object(["auto_resume_interrupted_sessions": .bool(value)])) }
                        catch { preferencesError = error.localizedDescription }
                    }
                }))
                RuntimeSettingsError(message: preferencesError)
            }
            RuntimeSettingsSection(title: "Updates") {
                LabeledContent("Current native version", value: currentVersion)
                LabeledContent("Status", value: updater.state.replacingOccurrences(of: "_", with: " ").capitalized)
                RuntimeSettingsError(message: updater.error)
                if let version = updater.version {
                    Divider()
                    Text("FalconDeck \(version)").fontWeight(.medium)
                    if let notes = updater.releaseNotes, !notes.isEmpty {
                        ScrollView { Text(notes).font(NativePreferences.shared.font(size: 13)).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }.frame(maxHeight: 220)
                    }
                }
                if let progress = updater.progress { ProgressView(value: progress).accessibilityLabel("Update download") }
                HStack {
                    if ["checking", "downloading"].contains(updater.state) { ProgressView().controlSize(.small) }
                    Button("Check for updates") { Task { await updater.check() } }.disabled(!updater.canCheck)
                    if updater.state == "available" {
                        Button("Download and install") { Task { await updater.downloadAndInstall() } }.buttonStyle(.borderedProminent)
                    }
                    if updater.state == "installed" {
                        Button("Restart to update") { Task { await updater.restart() } }.buttonStyle(.borderedProminent)
                    }
                    Link("View downloads", destination: URL(string: "https://github.com/jamesblackwell/falcondeck/releases")!)
                }
                Text("Updates include the app and its local services. Your projects and conversations are preserved.")
                    .font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
            }
            RuntimeSettingsSection(title: "First-run setup", detail: "Review connection, project and computer-use setup without changing existing projects, conversations or keys.") {
                HStack {
                    Button("Open welcome setup") { showWelcome = true }
                    Button(resetWelcome ? "Welcome will appear next launch" : "Show welcome at next launch") {
                        UserDefaults.standard.set(false, forKey: "falcondeck.native.onboarding.complete")
                        resetWelcome = true
                    }.disabled(resetWelcome)
                }
            }
        }
        .sheet(isPresented: $showWelcome) { NativeWelcomeSetupView(store: store) { showWelcome = false; resetWelcome = false } }
    }

}

struct NativeWelcomeSetupView: View {
    let store: AppStore
    let onComplete: () -> Void
    @State private var step = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 12) {
                Image(systemName: "paperplane.fill").font(.title2).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Welcome to FalconDeck").font(NativePreferences.shared.font(size: 22)).fontWeight(.semibold)
                    Text("Your agents, projects and conversations on this Mac.").foregroundStyle(.secondary)
                }
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    switch step {
                    case 0:
                        RuntimeSettingsSection(title: "Connect to your agents") {
                            Label(store.isConnected ? "Connected to your Mac" : store.connectionStatus, systemImage: store.isConnected ? "checkmark.circle.fill" : "network")
                                .foregroundStyle(store.isConnected ? Color.green : Color.secondary)
                            Text("Your existing projects and conversations appear automatically when FalconDeck connects. Agent sessions and history stay on this Mac.")
                                .font(NativePreferences.shared.font(size: 13)).foregroundStyle(.secondary)
                            Button("Reconnect") { Task { await store.reconnect() } }
                        }
                        RuntimeSettingsSection(title: "Your projects") {
                            Text(store.projects.isEmpty ? "Open a project folder to begin. Install and sign in to your preferred coding agent from Settings → Agents or Harnesses." : "\(store.projects.count) projects are ready. Choose one in the sidebar or open another folder.")
                                .foregroundStyle(.secondary)
                            Button("Open project folder…") { openProject() }
                        }
                    case 1:
                        NativeComputerUseSettingsView(store: store)
                    default:
                        RuntimeSettingsSection(title: "Ready when you are") {
                            Text("Select a project, start a task and send your first message. You can configure agents, notifications, voice, appearance and shortcuts in Settings.")
                                .foregroundStyle(.secondary)
                            Label("⌘N starts a task", systemImage: "square.and.pencil")
                            Label("⌘, opens Settings", systemImage: "gearshape")
                        }
                    }
                }.padding(2)
            }
            Divider()
            HStack {
                Text("\(step + 1) of 3").font(NativePreferences.shared.font(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button("Skip setup") { finish() }
                if step > 0 { Button("Back") { step -= 1 } }
                Button(step == 2 ? "Get started" : "Continue") { if step == 2 { finish() } else { step += 1 } }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(28).frame(width: 650, height: 610)
    }

    @MainActor private func openProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.prompt = "Open project"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await store.openProject(path: url.path) }
    }

    private func finish() {
        UserDefaults.standard.set(true, forKey: "falcondeck.native.onboarding.complete")
        onComplete()
    }
}
