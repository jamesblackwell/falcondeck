import SwiftUI

struct AutomationEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let definition: JSON?
    let settings: JSON
    @State private var draft: AutomationDraft
    @State private var scheduleChanged = false
    @State private var pending = false
    @State private var error: String?
    init(definition: JSON?, settings: JSON, workspacePath: String) {
        self.definition = definition; self.settings = settings
        _draft = State(initialValue: AutomationDraft(definition: definition, settings: settings, workspacePath: workspacePath))
    }
    private var providers: [String] { Array(Set([draft.provider, "codex", "claude", "grok", "agy"] + model.projects.flatMap(\.providers))).sorted() }
    private var elevatedBlocked: Bool { draft.elevated && !settings["allow_elevated_automations"].bool }
    var body: some View {
        NavigationStack {
            Form {
                Section("Automation") {
                    TextField("Name", text: $draft.name).accessibilityIdentifier("automation-name")
                    TextField("Description (optional)", text: $draft.description, axis: .vertical)
                    TextField("What should the agent do?", text: $draft.instruction, axis: .vertical).lineLimit(3...12).accessibilityIdentifier("automation-instruction")
                    Toggle("Only act when needed", isOn: $draft.conditional)
                    if draft.conditional { TextField("No-action marker", text: $draft.noActionMarker).textInputAutocapitalization(.never).autocorrectionDisabled() }
                }.listRowBackground(FD.surface)
                Section("Schedule") {
                    Picker("Repeat", selection: $draft.scheduleKind) { Text("Cron").tag("cron"); Text("Interval").tag("interval"); Text("Once").tag("once") }
                    if draft.scheduleKind == "cron" {
                        TextField("Cron expression", text: $draft.expression).textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("Timezone", text: $draft.timezone).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Text("Five fields: minute, hour, day, month, weekday.").font(.caption).foregroundStyle(FD.secondary)
                    } else if draft.scheduleKind == "interval" { TextField("Interval in seconds (60 minimum)", text: $draft.everySeconds).keyboardType(.numberPad) }
                    else { DatePicker("Run at", selection: $draft.runAt) }
                }.listRowBackground(FD.surface)
                Section("Agent task") {
                    if !model.projects.isEmpty {
                        Picker("Project", selection: $draft.workspacePath) {
                            if !model.projects.contains(where: { $0.path == draft.workspacePath }) { Text(draft.workspacePath.nonempty ?? "Choose a project").tag(draft.workspacePath) }
                            ForEach(model.sortedProjects) { Text($0.name).tag($0.path) }
                        }
                    }
                    TextField("Project path on computer", text: $draft.workspacePath).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("Agent", selection: $draft.provider) { ForEach(providers, id: \.self) { Text($0.capitalized).tag($0) } }
                    Picker("Task", selection: $draft.threadKind) { Text("Managed task").tag("managed"); Text("Existing task").tag("existing"); Text("New task each run").tag("new_each_run") }
                    if draft.threadKind == "existing" {
                        Picker("Existing task", selection: $draft.threadID) {
                            if !model.tasks.contains(where: { $0.id == draft.threadID }) { Text(draft.threadID.nonempty ?? "Choose a task").tag(draft.threadID) }
                            ForEach(model.tasks.filter { task in model.projects.first(where: { $0.id == task.projectID })?.path == draft.workspacePath && task.provider == draft.provider }) { Text($0.title).tag($0.id) }
                        }
                        TextField("Task ID", text: $draft.threadID).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    TextField("Model (agent default)", text: $draft.modelID).textInputAutocapitalization(.never).autocorrectionDisabled()
                }.listRowBackground(FD.surface)
                Section("Execution") {
                    TextField("Permission mode (default)", text: $draft.permissionMode).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Sandbox mode (default)", text: $draft.sandboxMode).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Required connectors, comma separated", text: $draft.connectors).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Skills, comma separated", text: $draft.skills).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("If already running", selection: $draft.concurrency) { Text("Skip").tag("skip"); Text("Queue one").tag("queue_one"); Text("Allow overlap").tag("allow") }
                    Picker("If a run is missed", selection: $draft.misfire) { Text("Skip").tag("skip"); Text("Run once").tag("run_once") }
                    if draft.elevated { Text(elevatedBlocked ? "Elevated automations are disabled on your computer." : "This automation runs with elevated permissions.").font(.footnote).foregroundStyle(.orange) }
                }.listRowBackground(FD.surface)
                if let error { Text(error).foregroundStyle(.orange).listRowBackground(FD.surface) }
                if let validation = draft.validationError { Text(validation).font(.footnote).foregroundStyle(FD.secondary).listRowBackground(FD.surface) }
            }.disabled(pending)
            .scrollContentBackground(.hidden).background(FD.background).navigationTitle(definition == nil ? "New automation" : "Edit automation").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending) }
                ToolbarItem(placement: .confirmationAction) { Button(pending ? "Saving…" : "Save") { save() }.disabled(pending || draft.validationError != nil || elevatedBlocked || (!model.connected && !model.demo)).accessibilityIdentifier("save-automation") }
            }
            .onChange(of: draft.scheduleKind) { _, _ in scheduleChanged = true }
            .onChange(of: draft.expression) { _, _ in scheduleChanged = true }
            .onChange(of: draft.timezone) { _, _ in scheduleChanged = true }
            .onChange(of: draft.everySeconds) { _, _ in scheduleChanged = true }
            .onChange(of: draft.runAt) { _, _ in scheduleChanged = true }
            .onChange(of: draft.provider) { _, _ in if draft.threadKind == "managed" { draft.threadID = "" }; draft.modelID = ""; draft.permissionMode = ""; draft.sandboxMode = "" }
        }.interactiveDismissDisabled(pending)
    }
    private func save() {
        guard !pending else { return }; pending = true; error = nil
        Task {
            defer { pending = false }
            do {
                var arguments = try draft.arguments(includeTrigger: definition == nil || scheduleChanged)
                if let definition { arguments = arguments.setting("automation_id", definition["id"]) }
                try await model.automations.execute(definition == nil ? "automation.create" : "automation.update", arguments: arguments, revision: definition?["revision"].optionalInt, model: model)
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
