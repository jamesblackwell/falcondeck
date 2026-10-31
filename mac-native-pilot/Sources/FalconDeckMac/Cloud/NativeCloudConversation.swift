import SwiftUI

enum NativeCloudConversation {
    static func validationError(target: String, provider: String, project: Project?, hasAttachments: Bool) -> String? {
        guard target == "cloud" else { return nil }
        guard project != nil, project?.raw["kind"].string != "casual" else { return "Choose a project before running in the cloud." }
        guard provider == "codex" else { return "Cloud currently supports Codex. Choose Codex to send this task." }
        guard !hasAttachments else { return "Cloud currently accepts text instructions. Remove the attachments before sending." }
        return nil
    }

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "provisioning": "Preparing cloud environment…"
        case "running": "Running in the cloud"
        case "awaiting_input": "Cloud environment ready"
        case "stopping": "Saving cloud environment…"
        case "stopped": "Cloud paused · send a message to resume"
        case "completed": "Cloud work finished"
        case "failed": "Cloud environment needs attention"
        case "expired": "Cloud environment expired"
        case "unknown": "Cloud connection needs attention"
        default: "Cloud"
        }
    }

    @MainActor static func openSettings(_ store: AppStore) {
        UserDefaults.standard.set("cloud", forKey: "falcondeck.native.settings.section")
        store.selectSection("settings")
        NotificationCenter.default.post(name: .init("falcondeck.native.openSettingsSection"), object: "cloud")
    }
}

/// Execution is chosen in the same composer that creates an ordinary task.
struct NativeConversationLocation: View {
    @Bindable var store: AppStore
    @Binding var selection: NativeComposerSelection

    private var isCloud: Bool { selection.effectiveExecutionTarget(task: store.selectedTask) == "cloud" }

    var body: some View {
        HStack(spacing: 12) {
            if let project = store.selectedProject {
                Label(project.name, systemImage: "folder").lineLimit(1)
            }
            if store.selectedTask == nil {
                Menu {
                    Button { selection.executionTarget = "local" } label: {
                        Label("Local", systemImage: isCloud ? "laptopcomputer" : "checkmark")
                    }
                    Button {
                        selection.executionTarget = "cloud"
                        // Only the qualified cloud harness is offered. Local
                        // credentials and local custom agents are not copied.
                        if store.provider != "codex" {
                            selection = selection.validated(project: store.selectedProject, provider: "codex")
                            let key = "selection:" + (store.selectedProjectID ?? "") + ":codex"
                            ConversationLocalStorage.save(selection, key: key)
                        }
                        store.provider = "codex"
                    } label: {
                        Label("Cloud", systemImage: isCloud ? "checkmark" : "cloud")
                    }.disabled(store.selectedProject?.raw["kind"].string == "casual")
                    Divider()
                    Button("Cloud settings…") { NativeCloudConversation.openSettings(store) }
                } label: {
                    Label(isCloud ? "Cloud" : "Local", systemImage: isCloud ? "cloud" : "laptopcomputer")
                }
                .menuStyle(.borderlessButton).fixedSize()
                .help("Choose where this task runs")
                .accessibilityIdentifier("composer-execution-target")
                if !isCloud && store.selectedProject?.raw["kind"].string != "casual" {
                    Picker("Working copy", selection: $selection.isolation) {
                        Text("Project folder").tag("project_folder")
                        Text("Isolated copy").tag("isolated")
                    }.labelsHidden().pickerStyle(.menu).fixedSize()
                }
            } else {
                Label(isCloud ? "Cloud" : "Local", systemImage: isCloud ? "cloud" : "laptopcomputer")
                    .help(isCloud ? "This conversation runs in its own cloud environment" : "This conversation runs on its project host")
            }
            Spacer(minLength: 0)
        }
        .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
        .padding(.horizontal, 12).padding(.vertical, 9)
        .overlay(alignment: .bottom) { FDTheme.hairline.frame(height: 1) }
    }
}

struct NativeCloudNewTaskNote: View {
    let store: AppStore
    @State private var settings: JSON = .null
    @State private var loadError: String?
    private var hostID: String? { store.selectedHostID }
    private var issue: String? {
        loadError ?? (settings == .null ? nil : NativeCloudSettingsDraft.validationError(settings: settings))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            if let issue {
                Image(systemName: "cloud").foregroundStyle(FDTheme.muted)
                Text(issue)
                    .foregroundStyle(FDTheme.warning)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button("Set up Cloud") { NativeCloudConversation.openSettings(store) }
                    .buttonStyle(.plain).foregroundStyle(FDTheme.accent).fixedSize()
            }
        }
        .font(NativePreferences.shared.font(size: 12))
        .task(id: hostID ?? "local") {
            do { settings = try await store.request(["api", "cloud", "settings"], hostID: hostID); loadError = nil }
            catch { loadError = "Cloud settings could not be loaded. \(error.localizedDescription)" }
        }
    }
}

/// Lifecycle controls are contextual to this normal conversation. Conversation
/// items and approvals continue to come from AppStore's ordinary thread routes.
struct NativeCloudConversationPanel: View {
    let store: AppStore
    let task: AgentTask
    @State private var job: JSON = .null
    @State private var busy = false
    @State private var error: String?
    @State private var reviewing = false
    private var jobID: String { task.raw["cloud"]["job_id"].string }
    private var status: String { task.cloudStatus.isEmpty ? job["status"].string : task.cloudStatus }
    private var result: JSON { job["result"] }
    private var hasResult: Bool { task.raw["cloud"]["has_result"].bool || result != .null }
    private var statusError: String { task.raw["cloud"]["error"].string }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if ["provisioning", "stopping"].contains(status) { MacActivityDiamond(size: 7) }
                else { Image(systemName: "cloud") }
                Text(NativeCloudConversation.statusLabel(status)).lineLimit(2)
                Spacer(minLength: 4)
                if hasResult {
                    Button("Review changes") { reviewing = true }
                        .buttonStyle(.plain).foregroundStyle(FDTheme.accent)
                }
                Menu {
                    if status == "stopped" {
                        Button("Resume cloud environment") { operate("resume") }
                    }
                    if ["completed", "failed"].contains(status) {
                        Button("Collect changes") { operate("collect") }
                    }
                    if !["stopped", "expired", "stopping"].contains(status) {
                        Button("Stop cloud environment") { operate("stop") }
                    }
                    Divider()
                    Button("Cloud settings…") { NativeCloudConversation.openSettings(store) }
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("Cloud environment actions")
            }
            if !statusError.isEmpty { Text(statusError).foregroundStyle(FDTheme.warning).textSelection(.enabled) }
            if let error { Text(error).foregroundStyle(FDTheme.warning).textSelection(.enabled) }
        }
        .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
        .disabled(busy || !store.isSelectedHostConnected)
        .task(id: task.id + ":" + task.cloudStatus + ":" + String(task.raw["cloud"]["has_result"].bool)) { await refresh() }
        .sheet(isPresented: $reviewing) { resultSheet }
    }

    private var resultSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Cloud changes").font(NativePreferences.shared.font(size: 18, weight: .semibold))
            Text("Apply this environment’s changes to the source project. Files changed locally since the cloud copy was taken are kept and reported as conflicts.")
                .font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(result["changed_paths"].array, id: \.self) { Text($0.string).foregroundStyle(FDTheme.secondary) }
                    ForEach(result["deleted_paths"].array, id: \.self) { Text("Deleted · " + $0.string).foregroundStyle(FDTheme.warning) }
                    if result == .null { Text("Loading collected changes…").foregroundStyle(FDTheme.muted) }
                    else if result["changed_paths"].array.isEmpty && result["deleted_paths"].array.isEmpty { Text("No source changes.").foregroundStyle(FDTheme.muted) }
                }.font(NativePreferences.shared.font(size: 12, surface: "code")).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }.frame(minHeight: 100, maxHeight: 280)
            if let error { Text(error).font(.callout).foregroundStyle(FDTheme.warning).textSelection(.enabled) }
            HStack {
                Button("Close") { reviewing = false }.keyboardShortcut(.cancelAction)
                Spacer()
                if result["imported_at"] != .null { Label("Changes imported", systemImage: "checkmark.circle").foregroundStyle(FDTheme.accent) }
                else {
                    Button(busy ? "Applying…" : "Apply changes to project") { operate("import") }
                        .buttonStyle(.borderedProminent).tint(FDTheme.accent)
                        .disabled(busy || result == .null || !store.isSelectedHostConnected)
                }
            }
        }.padding(24).frame(width: 560)
        .task { await refresh() }
    }

    private func refresh() async {
        guard !jobID.isEmpty else { error = "This cloud conversation has no environment identity."; return }
        do { job = try await store.request(["api", "cloud", "jobs", jobID]); error = nil }
        catch { self.error = error.localizedDescription }
    }

    private func operate(_ action: String) {
        guard !busy, !jobID.isEmpty else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await store.request(["api", "cloud", "jobs", jobID, action], method: "POST")
                await refresh()
            } catch { self.error = error.localizedDescription }
        }
    }
}
