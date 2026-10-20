import SwiftUI
import Observation

private struct MacAutomation: Identifiable, Hashable {
    let raw: JSON
    var id: String { raw["id"].string }
    var name: String { raw["name"].string }
    var enabled: Bool { raw["state"].string == "enabled" }
    var revision: Int { raw["revision"].int }
    var owned: Bool { !raw["owner"]["extension_id"].string.isEmpty }
    var schedule: String {
        let resolved = raw["resolved_schedule"].string
        if !resolved.isEmpty { return resolved }
        let trigger = raw["trigger"]
        switch trigger["kind"].string {
        case "interval":
            let seconds = trigger["every_seconds"].int
            if seconds % 3600 == 0 { return "Every \(seconds / 3600) hours" }
            if seconds % 60 == 0 { return "Every \(seconds / 60) minutes" }
            return "Every \(seconds) seconds"
        case "once": return MacAutomationDraft.date(trigger["run_at"].string)?.formatted(date: .abbreviated, time: .shortened) ?? trigger["run_at"].string
        default: return "\(trigger["expression"].string) · \(trigger["timezone"].string)"
        }
    }
}

/// Definitions and run history stay authoritative in the daemon. In-flight reads
/// cannot replace a definition changed by a more recent mutation.
@MainActor @Observable
private final class MacAutomationState {
    var rows: [MacAutomation] = []
    var settings: JSON = .null
    var loading = false
    var busyID: String?
    var error: String?
    var notice: String?
    private var loadID = UUID()

    func refresh(store: AppStore) async {
        let identity = UUID()
        loadID = identity
        loading = true
        defer { if loadID == identity { loading = false } }
        do {
            async let definitions = Self.readPages(store: store, resource: "automations")
            async let controls: JSON? = try? await store.request(path: "/api/control/get", method: "POST", body: .object(["resource": .string("agent_control.settings")]))
            let (values, response) = try await (definitions, controls)
            guard loadID == identity, !Task.isCancelled else { return }
            rows = values.map { MacAutomation(raw: $0) }
            if let response { settings = response["data"] }
            error = nil
        } catch {
            guard loadID == identity, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    static func readPages(store: AppStore, resource: String, id: String? = nil) async throws -> [JSON] {
        var result: [JSON] = [], cursor = "", seen = Set<String>()
        repeat {
            try Task.checkCancellation()
            var arguments: [String: JSON] = ["resource": .string(resource), "limit": .number(100)]
            if let id { arguments["id"] = .string(id) }
            if !cursor.isEmpty { arguments["cursor"] = .string(cursor) }
            let response = try await store.request(path: "/api/control/get", method: "POST", body: .object(arguments))
            result.append(contentsOf: response["data"].array)
            cursor = response["next_cursor"].string
            guard !cursor.isEmpty else { break }
            guard seen.insert(cursor).inserted else { throw PilotError("The daemon returned a repeated page of results. Refresh to try again.") }
        } while true
        return result
    }

    func read(_ row: MacAutomation, store: AppStore) async throws -> JSON {
        let response = try await store.request(path: "/api/control/get", method: "POST", body: .object(["resource": .string("automation"), "id": .string(row.id)]))
        let definition = response["data"]
        guard definition["id"].string == row.id, definition["task"] != .null else { throw PilotError("This automation is no longer available. Refresh to try again.") }
        return definition
    }

    @discardableResult
    func execute(_ operation: String, arguments: JSON, revision: Int? = nil, store: AppStore) async throws -> JSON {
        loadID = UUID()
        loading = false
        var body = JSON.object(["operation": .string(operation), "arguments": arguments, "idempotency_key": .string("native-mac-\(UUID().uuidString)")])
        if let revision { body = body.setting("expected_revision", .number(Double(revision))) }
        let response = try await store.request(path: "/api/control/execute", method: "POST", body: body)
        guard response["ok"].bool else {
            await refresh(store: store)
            let detail = response["error"]
            let fields = detail["field_errors"].array.map { "\($0["field"].string): \($0["message"].string)" }.joined(separator: "\n")
            let suggestion = detail["suggested_action"].string
            let message = detail["message"].string
            throw PilotError([message.isEmpty ? "The automation could not be updated." : message, fields, suggestion].filter { !$0.isEmpty }.joined(separator: "\n"))
        }
        await refresh(store: store)
        return response["data"]
    }
}

private struct MacAutomationEditorTarget: Identifiable {
    let id = UUID()
    let definition: JSON?
    var reschedule = false
}

struct NativeAutomationsView: View {
    let store: AppStore
    @State private var model = MacAutomationState()
    @State private var editor: MacAutomationEditorTarget?
    @State private var history: MacAutomation?
    @State private var deleting: MacAutomation?
    @State private var search = ""
    @State private var stateFilter = "all"

    private var filtered: [MacAutomation] {
        model.rows.filter { row in
            (stateFilter == "all" || row.raw["state"].string == stateFilter) &&
            (search.isEmpty || [row.name, row.raw["description"].string, row.raw["target"]["workspace_path"].string].contains { $0.localizedCaseInsensitiveContains(search) })
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let error = model.error { banner(error, symbol: "exclamationmark.triangle", color: FDTheme.danger) }
            if let notice = model.notice { banner(notice, symbol: "checkmark.circle", color: FDTheme.accent) }
            if model.loading && model.rows.isEmpty {
                ProgressView("Loading automations…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if filtered.isEmpty {
                NativeEmptyState(symbol: "calendar.badge.clock", title: model.rows.isEmpty ? "No automations yet" : "No matching automations", detail: model.rows.isEmpty ? "Schedule an agent task to run on your Mac. The daemon must be running at the scheduled time." : "Try another search or state filter.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) { ForEach(filtered) { row in automationCard(row) } }
                        .padding(24).frame(maxWidth: 1000).frame(maxWidth: .infinity)
                }
            }
        }
        .background(FDTheme.background)
        .task(id: store.isConnected) {
            await model.refresh(store: store)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                if model.busyID == nil { await model.refresh(store: store) }
            }
        }
        .sheet(item: $editor) { target in
            MacAutomationEditor(store: store, model: model, definition: target.definition, reschedule: target.reschedule)
        }
        .sheet(item: $history) { row in MacAutomationHistory(store: store, automation: row) }
        .confirmationDialog("Delete \(deleting?.name ?? "automation")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Delete automation", role: .destructive) {
                if let row = deleting { operate(row, operation: "automation.delete") }
                deleting = nil
            }
        } message: { Text("Future runs stop. Existing agent tasks are kept.") }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Automations").font(NativePreferences.shared.font(size: 18, weight: .semibold))
                    Text("Scheduled agent instructions that run through your existing tasks.").foregroundStyle(FDTheme.muted)
                }
                Spacer()
                Button { Task { await model.refresh(store: store) } } label: { Image(systemName: "arrow.clockwise") }.help("Refresh automations").disabled(model.loading)
                Button("New automation", systemImage: "plus") { editor = MacAutomationEditorTarget(definition: nil) }
                    .buttonStyle(.borderedProminent).tint(FDTheme.accent).disabled(!store.isConnected || model.busyID != nil)
            }
            HStack {
                TextField("Search automations", text: $search).textFieldStyle(.roundedBorder).frame(maxWidth: 360)
                Picker("State", selection: $stateFilter) {
                    Text("All states").tag("all")
                    Text("Enabled").tag("enabled")
                    Text("Paused").tag("paused")
                    Text("Completed").tag("completed")
                    Text("Failed").tag("failed")
                }.frame(width: 170)
                Spacer()
                Text("\(model.rows.count) automations").font(.caption).foregroundStyle(FDTheme.muted)
            }
        }.padding(24)
    }

    private func automationCard(_ row: MacAutomation) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: row.enabled ? "calendar.badge.clock" : "pause.circle").foregroundStyle(row.enabled ? FDTheme.accent : FDTheme.muted).font(.title3)
                Text(row.name).font(.headline).lineLimit(2)
                statusBadge(row.raw["state"].string)
                Text(FDTheme.providerName(row.raw["target"]["provider"].string)).font(.caption).foregroundStyle(FDTheme.muted)
                if row.raw["elevated"].bool { Text("Elevated").font(.caption).foregroundStyle(FDTheme.warning) }
                Spacer()
                if model.busyID == row.id { ProgressView().controlSize(.small) }
                if !row.owned {
                    if row.enabled {
                        Button("Pause", systemImage: "pause") { operate(row, operation: "automation.pause") }
                    } else if row.raw["state"].string == "paused" {
                        Button("Resume", systemImage: "play") { operate(row, operation: "automation.resume") }
                    } else {
                        Button("Edit schedule", systemImage: "calendar") { edit(row, reschedule: true) }
                    }
                    if row.enabled || row.raw["state"].string == "paused" {
                        Button("Run now", systemImage: "play.circle") { operate(row, operation: "automation.run_now") }
                    }
                }
                Menu {
                    Button("Run history", systemImage: "clock") { history = row }
                    if !row.owned {
                        Button("Edit", systemImage: "pencil") { edit(row) }
                        Divider()
                        Button("Delete automation…", systemImage: "trash", role: .destructive) { deleting = row }
                    }
                } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 24)
            }
            .disabled(model.busyID != nil || !store.isConnected)
            if !row.raw["description"].string.isEmpty { Text(row.raw["description"].string).foregroundStyle(FDTheme.secondary).textSelection(.enabled) }
            HStack(spacing: 18) {
                Label(row.schedule, systemImage: "clock").foregroundStyle(FDTheme.secondary)
                if let next = MacAutomationDraft.date(row.raw["next_run_at"].string) { Text("Next: \(next.formatted(date: .abbreviated, time: .shortened))").foregroundStyle(FDTheme.muted) }
            }.font(.callout)
            Label(row.raw["target"]["workspace_path"].string, systemImage: "folder").font(.caption).foregroundStyle(FDTheme.muted).textSelection(.enabled)
            if row.owned { Text("Managed by \(row.raw["owner"]["extension_id"].string)").font(.caption).foregroundStyle(FDTheme.muted) }
            if !row.raw["latest_outcome"]["preview"].string.isEmpty {
                Divider()
                HStack(alignment: .top) {
                    statusBadge(row.raw["latest_outcome"]["status"].string)
                    Text(row.raw["latest_outcome"]["preview"].string).font(.callout).foregroundStyle(FDTheme.secondary).lineLimit(3)
                }
            }
        }.padding(18).background(FDTheme.surface, in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(FDTheme.line))
    }

    private func statusBadge(_ value: String) -> some View {
        let color = value == "enabled" || value.hasPrefix("succeeded") ? FDTheme.accent : value == "failed" ? FDTheme.danger : FDTheme.muted
        return Text(value.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption.weight(.medium)).foregroundStyle(color).padding(.horizontal, 8).padding(.vertical, 3).background(color.opacity(0.10), in: Capsule())
    }

    private func banner(_ text: String, symbol: String, color: Color) -> some View {
        HStack(alignment: .top) {
            Label(text, systemImage: symbol).foregroundStyle(color).textSelection(.enabled)
            Spacer()
            Button { model.error = nil; model.notice = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("Dismiss message")
        }.padding(12).background(color.opacity(0.08))
    }

    private func edit(_ row: MacAutomation, reschedule: Bool = false) {
        guard model.busyID == nil else { return }
        model.busyID = row.id; model.error = nil
        Task {
            defer { model.busyID = nil }
            do { editor = MacAutomationEditorTarget(definition: try await model.read(row, store: store), reschedule: reschedule) }
            catch { model.error = error.localizedDescription }
        }
    }

    private func operate(_ row: MacAutomation, operation: String) {
        guard model.busyID == nil else { return }
        model.busyID = row.id; model.error = nil; model.notice = nil
        Task {
            defer { model.busyID = nil }
            do {
                try await model.execute(operation, arguments: .object(["automation_id": .string(row.id)]), revision: operation == "automation.run_now" ? nil : row.revision, store: store)
                model.notice = operation == "automation.run_now" ? "Run queued for \(row.name)." : "Automation updated."
            } catch { model.error = error.localizedDescription }
        }
    }
}

struct MacAutomationDraft {
    var name = ""
    var description = ""
    var scheduleKind = "cron"
    var expression = "0 8 * * 1-5"
    var timezone = TimeZone.current.identifier
    var everySeconds = "3600"
    var runAt = Date.now.addingTimeInterval(3600)
    var instruction = ""
    var conditional = false
    var noActionMarker = "FALCONDECK_NO_ACTION"
    var workspacePath = ""
    var provider = "codex"
    var threadKind = "managed"
    var threadID = ""
    var modelID = ""
    var permissionMode = ""
    var sandboxMode = ""
    var reasoningEffort = ""
    var collaborationModeID = ""
    var approvalPolicy = ""
    var isolation = "project_folder"
    var connectors = ""
    var skills = ""
    var concurrency = "skip"
    var misfire = "skip"
    var anchorAt = ""
    var originalTarget = JSON.object([:])

    init(definition: JSON? = nil, settings: JSON = .null, workspacePath: String = "") {
        self.workspacePath = workspacePath
        if !settings["default_timezone"].string.isEmpty { timezone = settings["default_timezone"].string }
        guard let raw = definition else { return }
        name = raw["name"].string; description = raw["description"].string
        scheduleKind = raw["trigger"]["kind"].string
        expression = raw["trigger"]["expression"].string
        if !raw["trigger"]["timezone"].string.isEmpty { timezone = raw["trigger"]["timezone"].string }
        everySeconds = raw["trigger"]["every_seconds"].optionalInt.map(String.init) ?? "3600"
        anchorAt = raw["trigger"]["anchor_at"].string
        runAt = Self.date(raw["trigger"]["run_at"].string) ?? runAt
        instruction = raw["task"]["instruction"].string
        conditional = raw["task"]["kind"].string == "conditional_prompt"
        if !raw["task"]["no_action_marker"].string.isEmpty { noActionMarker = raw["task"]["no_action_marker"].string }
        originalTarget = raw["target"]
        self.workspacePath = raw["target"]["workspace_path"].string
        provider = raw["target"]["provider"].string
        if !raw["target"]["thread"]["kind"].string.isEmpty { threadKind = raw["target"]["thread"]["kind"].string }
        threadID = raw["target"]["thread"]["thread_id"].string
        modelID = raw["target"]["model_id"].string
        permissionMode = raw["target"]["permission_mode"].string
        sandboxMode = raw["target"]["sandbox_mode"].string
        reasoningEffort = raw["target"]["reasoning_effort"].string
        collaborationModeID = raw["target"]["collaboration_mode_id"].string
        approvalPolicy = raw["target"]["approval_policy"].string
        if !raw["target"]["isolation"].string.isEmpty { isolation = raw["target"]["isolation"].string }
        connectors = raw["required_connectors"].array.map(\.string).joined(separator: ", ")
        skills = raw["target"]["selected_skills"].array.map(\.string).joined(separator: ", ")
        if !raw["concurrency_policy"].string.isEmpty { concurrency = raw["concurrency_policy"].string }
        if !raw["misfire_policy"].string.isEmpty { misfire = raw["misfire_policy"].string }
    }

    var scheduleFingerprint: String { [scheduleKind, expression, timezone, everySeconds, runAt.ISO8601Format()].joined(separator: "|") }
    var elevated: Bool { [permissionMode, sandboxMode].contains { ["bypassPermissions", "danger-full-access"].contains(Self.trim($0)) } }
    var validationError: String? {
        if Self.trim(name).isEmpty { return "A name is required." }
        if Self.trim(name).unicodeScalars.count > 120 { return "Names can contain at most 120 characters." }
        if Self.trim(description).unicodeScalars.count > 2000 { return "Descriptions can contain at most 2,000 characters." }
        if Self.trim(instruction).isEmpty { return "An instruction is required." }
        if instruction.unicodeScalars.count > 32_000 { return "Instructions can contain at most 32,000 characters." }
        if !Self.trim(workspacePath).hasPrefix("/") { return "Project path must be absolute on your Mac." }
        if Self.trim(provider).isEmpty { return "Choose an agent." }
        if !["cron", "interval", "once"].contains(scheduleKind) { return "Choose a supported schedule." }
        if scheduleKind == "cron", expression.split(whereSeparator: \.isWhitespace).count != 5 { return "Cron expressions need five fields: minute, hour, day, month and weekday." }
        if scheduleKind == "cron", TimeZone(identifier: Self.trim(timezone)) == nil { return "Enter a valid timezone, such as Europe/London." }
        if scheduleKind == "interval", Int(Self.trim(everySeconds)).map({ $0 >= 60 && $0 <= 9_007_199_254_740_991 }) != true { return "Intervals must be a whole number of at least 60 seconds." }
        if threadKind == "existing", Self.trim(threadID).isEmpty { return "Choose an existing task." }
        if conditional, Self.trim(noActionMarker).isEmpty { return "Conditional automations need a no-action marker." }
        if conditional, Self.trim(noActionMarker).unicodeScalars.count > 100 || Self.trim(noActionMarker).contains(where: { $0 == "\n" || $0 == "\r" }) { return "No-action markers must contain at most 100 characters on one line." }
        let required = Self.list(connectors)
        if required.count > 32 { return "At most 32 connectors may be required." }
        if required.contains(where: { $0.unicodeScalars.count > 64 }) { return "Connector names can contain at most 64 characters." }
        if Set(required).count != required.count { return "Each required connector should be listed only once." }
        return nil
    }

    func triggerValidationError(includeTrigger: Bool, now: Date = .now) -> String? {
        includeTrigger && scheduleKind == "once" && runAt <= now ? "Choose a future date and time for this one-time automation." : nil
    }

    func arguments(includeTrigger: Bool) throws -> JSON {
        if let validationError { throw PilotError(validationError) }
        if let error = triggerValidationError(includeTrigger: includeTrigger) { throw PilotError(error) }
        var target: [String: JSON] = [:]
        if originalTarget["provider"].string == provider, case .object(let original) = originalTarget { target = original }
        target["workspace_path"] = .string(Self.trim(workspacePath)); target["provider"] = .string(Self.trim(provider))
        var thread = JSON.object(["kind": .string(threadKind)])
        if threadKind != "new_each_run", !Self.trim(threadID).isEmpty { thread = thread.setting("thread_id", .string(Self.trim(threadID))) }
        target["thread"] = thread
        for (key, value) in [("model_id", modelID), ("permission_mode", permissionMode), ("sandbox_mode", sandboxMode), ("reasoning_effort", reasoningEffort), ("collaboration_mode_id", collaborationModeID), ("approval_policy", approvalPolicy)] {
            target.removeValue(forKey: key)
            if !Self.trim(value).isEmpty { target[key] = .string(Self.trim(value)) }
        }
        target["isolation"] = .string(isolation)
        target["selected_skills"] = .array(Self.list(skills).map(JSON.string))
        var task = JSON.object(["kind": .string(conditional ? "conditional_prompt" : "prompt"), "instruction": .string(instruction)])
        if conditional { task = task.setting("no_action_marker", .string(Self.trim(noActionMarker))) }
        var result = JSON.object(["name": .string(Self.trim(name)), "description": .string(Self.trim(description)), "task": task, "target": .object(target), "required_connectors": .array(Self.list(connectors).map(JSON.string)), "concurrency_policy": .string(concurrency), "misfire_policy": .string(misfire)])
        if includeTrigger {
            let trigger: JSON
            switch scheduleKind {
            case "interval":
                guard let seconds = Int(Self.trim(everySeconds)) else { throw PilotError("Enter an interval in seconds.") }
                trigger = .object(["kind": .string("interval"), "every_seconds": .number(Double(seconds)), "anchor_at": .string(anchorAt.isEmpty ? Date.now.ISO8601Format() : anchorAt)])
            case "once": trigger = .object(["kind": .string("once"), "run_at": .string(runAt.ISO8601Format())])
            default: trigger = .object(["kind": .string("cron"), "expression": .string(Self.trim(expression)), "timezone": .string(Self.trim(timezone))])
            }
            result = result.setting("trigger", trigger)
        }
        return result
    }

    static func trim(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
    static func list(_ value: String) -> [String] { value.split(separator: ",").map { trim(String($0)) }.filter { !$0.isEmpty } }
    static func date(_ value: String) -> Date? { (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value)) }
}

private struct MacAutomationEditor: View {
    let store: AppStore
    let model: MacAutomationState
    let definition: JSON?
    @Environment(\.dismiss) private var dismiss
    @State private var draft: MacAutomationDraft
    @State private var pending = false
    @State private var error: String?
    private let originalSchedule: String
    private let reschedule: Bool

    init(store: AppStore, model: MacAutomationState, definition: JSON?, reschedule: Bool = false) {
        self.store = store; self.model = model; self.definition = definition
        self.reschedule = reschedule
        let value = MacAutomationDraft(definition: definition, settings: model.settings, workspacePath: store.selectedProject?.path ?? store.projects.first?.path ?? "")
        _draft = State(initialValue: value)
        originalSchedule = value.scheduleFingerprint
    }

    private var providers: [String] { Array(Set([draft.provider, "codex", "claude", "grok", "agy"] + store.projects.flatMap(\.providers))).filter { !$0.isEmpty }.sorted() }
    private var eligibleTasks: [AgentTask] { store.tasks.filter { task in store.projects.first { $0.id == task.projectID }?.path == draft.workspacePath && task.provider == draft.provider } }
    private var elevatedBlocked: Bool { draft.elevated && !model.settings["allow_elevated_automations"].bool }
    private var includeTrigger: Bool { reschedule || definition == nil || draft.scheduleFingerprint != originalSchedule }
    private var validationError: String? { draft.validationError ?? draft.triggerValidationError(includeTrigger: includeTrigger) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(definition == nil ? "New automation" : "Edit automation").font(.title2.weight(.semibold))
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(pending)
                Button(pending ? "Saving…" : "Save") { save() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent).tint(FDTheme.accent)
                    .disabled(pending || validationError != nil || elevatedBlocked || !store.isConnected)
            }.padding(20)
            Divider()
            Form {
                Section("Automation") {
                    TextField("Name", text: $draft.name).accessibilityIdentifier("automation-name")
                    TextField("Description", text: $draft.description, axis: .vertical).lineLimit(1...3)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Instruction").font(.callout)
                        TextEditor(text: $draft.instruction).font(.body).frame(minHeight: 120).padding(6).background(FDTheme.background, in: RoundedRectangle(cornerRadius: 6)).accessibilityIdentifier("automation-instruction")
                    }
                    Toggle("Only act when needed", isOn: $draft.conditional)
                    if draft.conditional { TextField("No-action marker", text: $draft.noActionMarker) }
                }
                Section("Schedule") {
                    Picker("Repeat", selection: $draft.scheduleKind) { Text("Cron schedule").tag("cron"); Text("Fixed interval").tag("interval"); Text("Once").tag("once") }
                    if draft.scheduleKind == "cron" {
                        TextField("Cron expression", text: $draft.expression).monospaced()
                        TextField("Timezone", text: $draft.timezone)
                        Text("Five fields: minute, hour, day, month, weekday. Example: 0 8 * * 1-5 runs weekdays at 8am.").font(.caption).foregroundStyle(FDTheme.muted)
                    } else if draft.scheduleKind == "interval" { TextField("Interval in seconds", text: $draft.everySeconds) }
                    else { DatePicker("Run at", selection: $draft.runAt) }
                    Text("Your Mac and the FalconDeck daemon must be running for scheduled tasks.").font(.caption).foregroundStyle(FDTheme.muted)
                }
                Section("Agent task") {
                    if !store.projects.isEmpty {
                        Picker("Project", selection: $draft.workspacePath) {
                            if !store.projects.contains(where: { $0.path == draft.workspacePath }) { Text(draft.workspacePath.isEmpty ? "Choose a project" : draft.workspacePath).tag(draft.workspacePath) }
                            ForEach(store.projects.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }) { Text($0.name).tag($0.path) }
                        }
                    }
                    TextField("Project path", text: $draft.workspacePath)
                    Picker("Agent", selection: $draft.provider) { ForEach(providers, id: \.self) { Text(FDTheme.providerName($0)).tag($0) } }
                    Picker("Task", selection: $draft.threadKind) { Text("Reuse a managed task").tag("managed"); Text("Use an existing task").tag("existing"); Text("New task each run").tag("new_each_run") }
                    if draft.threadKind == "existing" {
                        Picker("Existing task", selection: $draft.threadID) {
                            if !eligibleTasks.contains(where: { $0.id == draft.threadID }) { Text(draft.threadID.isEmpty ? "Choose a task" : draft.threadID).tag(draft.threadID) }
                            ForEach(eligibleTasks) { Text($0.title).tag($0.id) }
                        }
                        TextField("Task ID", text: $draft.threadID)
                    }
                    TextField("Model (agent default if empty)", text: $draft.modelID)
                }
                Section("Execution") {
                    TextField("Permission mode (agent default)", text: $draft.permissionMode)
                    TextField("Sandbox mode (agent default)", text: $draft.sandboxMode)
                    TextField("Approval policy (agent default)", text: $draft.approvalPolicy)
                    TextField("Reasoning effort (agent default)", text: $draft.reasoningEffort)
                    TextField("Collaboration mode (agent default)", text: $draft.collaborationModeID)
                    Picker("Workspace", selection: $draft.isolation) { Text("Project folder").tag("project_folder"); Text("Isolated worktree").tag("isolated") }
                    TextField("Required connectors, comma separated", text: $draft.connectors)
                    TextField("Skills, comma separated", text: $draft.skills)
                    Picker("If already running", selection: $draft.concurrency) { Text("Skip this run").tag("skip"); Text("Queue one run").tag("queue_one"); Text("Allow overlapping runs").tag("allow") }
                    Picker("If a scheduled run is missed", selection: $draft.misfire) { Text("Skip missed runs").tag("skip"); Text("Run once when available").tag("run_once") }
                    if draft.elevated { Label(elevatedBlocked ? "Elevated automations are disabled in Agent Control settings." : "This automation runs with elevated permissions.", systemImage: "exclamationmark.shield").foregroundStyle(FDTheme.warning) }
                }
                if let error { Text(error).foregroundStyle(FDTheme.danger).textSelection(.enabled) }
                if let validation = validationError { Text(validation).font(.callout).foregroundStyle(FDTheme.muted) }
            }.formStyle(.grouped).disabled(pending)
        }
        .frame(width: 720, height: 780).background(FDTheme.background)
        .interactiveDismissDisabled(pending)
        .onChange(of: draft.provider) { _, _ in
            if draft.threadKind == "managed" { draft.threadID = "" }
            draft.modelID = ""; draft.permissionMode = ""; draft.sandboxMode = ""; draft.approvalPolicy = ""; draft.reasoningEffort = ""; draft.collaborationModeID = ""
        }
        .onChange(of: draft.workspacePath) { _, _ in if draft.threadKind == "managed" { draft.threadID = "" } }
    }

    private func save() {
        guard !pending else { return }
        pending = true; error = nil
        Task {
            defer { pending = false }
            do {
                var arguments = try draft.arguments(includeTrigger: includeTrigger)
                if let definition { arguments = arguments.setting("automation_id", definition["id"]) }
                try await model.execute(definition == nil ? "automation.create" : "automation.update", arguments: arguments, revision: definition?["revision"].optionalInt, store: store)
                model.notice = definition == nil ? "Automation created." : "Automation saved."
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}

private struct MacAutomationHistory: View {
    let store: AppStore
    let automation: MacAutomation
    @Environment(\.dismiss) private var dismiss
    @State private var runs: [JSON] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(automation.name).font(.title2.weight(.semibold))
                    Text("Run history").foregroundStyle(FDTheme.muted)
                }
                Spacer()
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }.disabled(loading)
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }.padding(20)
            Divider()
            if let error { Text(error).foregroundStyle(FDTheme.danger).padding().textSelection(.enabled) }
            if loading && runs.isEmpty { ProgressView("Loading run history…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            else if runs.isEmpty { NativeEmptyState(symbol: "clock", title: "No runs yet", detail: "Scheduled and manually started runs will appear here.") }
            else {
                List(runs, id: \.self) { run in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Image(systemName: run["status"].string == "failed" ? "exclamationmark.circle" : run["status"].string == "running" ? "arrow.triangle.2.circlepath" : "clock")
                            Text(run["status"].string.replacingOccurrences(of: "_", with: " ").capitalized).font(.headline)
                            Text(run["trigger"].string.capitalized).font(.caption).foregroundStyle(FDTheme.muted)
                            Spacer()
                            if let date = MacAutomationDraft.date(run["started_at"].string.isEmpty ? run["queued_at"].string : run["started_at"].string) { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(FDTheme.muted) }
                        }
                        if !run["outcome_preview"].string.isEmpty { Text(run["outcome_preview"].string).textSelection(.enabled) }
                        if !run["error"]["message"].string.isEmpty { Text(run["error"]["message"].string).foregroundStyle(FDTheme.danger).textSelection(.enabled) }
                        if !run["thread_id"].string.isEmpty {
                            Button("Open task", systemImage: "bubble.left.and.bubble.right") {
                                Task {
                                    await store.selectTask(run["thread_id"].string)
                                    dismiss()
                                }
                            }.disabled(!store.tasks.contains { $0.id == run["thread_id"].string })
                        }
                    }.padding(.vertical, 8)
                }.listStyle(.plain)
            }
        }.frame(width: 720, height: 560).background(FDTheme.background)
        .task {
            await load()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                await load()
            }
        }
    }

    private func load() async {
        guard !loading || runs.isEmpty else { return }
        loading = true
        defer { loading = false }
        do {
            let values = try await MacAutomationState.readPages(store: store, resource: "automation.runs", id: automation.id)
            guard !Task.isCancelled else { return }
            runs = values; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}
