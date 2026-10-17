import SwiftUI

private struct AutomationEditorTarget: Identifiable {
    let id = UUID()
    let definition: JSON?
}

struct AutomationsView: View {
    @Environment(AppModel.self) private var model
    @State private var editor: AutomationEditorTarget?
    @State private var history: NativeAutomation?
    @State private var deleting: NativeAutomation?
    @State private var pending: String?
    @State private var error: String?
    private var store: AutomationStore { model.automations }
    var body: some View {
        List {
            if let error = error ?? store.error { Text(error).foregroundStyle(.orange) }
            if store.loading && store.rows.isEmpty { HStack { ActivityDiamond(); Text("Loading automations…") } }
            ForEach(store.rows) { row in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image(systemName: row.enabled ? "calendar.badge.clock" : "pause.circle").foregroundStyle(row.enabled ? FD.accent : FD.secondary)
                        Text(row.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Spacer()
                        Menu {
                            Button(row.enabled ? "Pause" : "Resume", systemImage: row.enabled ? "pause" : "play") { run(row, operation: row.enabled ? "automation.pause" : "automation.resume", revision: row.revision) }
                            Button("Run now", systemImage: "play.circle") { run(row, operation: "automation.run_now") }
                            Button("Edit", systemImage: "pencil") { edit(row) }
                            Button("Run history", systemImage: "clock") { history = row }
                            Button("Delete", systemImage: "trash", role: .destructive) { deleting = row }
                        } label: { if pending == row.id { ActivityDiamond() } else { Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(.rect) } }
                            .accessibilityLabel("Automation options").disabled(pending != nil || (!model.connected && !model.demo))
                    }
                    if !row.raw["description"].string.isEmpty { Text(row.raw["description"].string).font(.subheadline).foregroundStyle(FD.secondary) }
                    Text(schedule(row.raw)).font(.footnote).foregroundStyle(FD.secondary)
                    HStack {
                        Text(row.raw["target"]["provider"].string.capitalized)
                        Text(row.raw["state"].string.capitalized)
                        if let next = AutomationDraft.parseDate(row.raw["next_run_at"].string) { Text("Next: \(next.formatted(date: .abbreviated, time: .shortened))") }
                    }.font(.caption).foregroundStyle(FD.muted)
                    if !row.raw["latest_outcome"]["preview"].string.isEmpty { Text(row.raw["latest_outcome"]["preview"].string).font(.footnote).lineLimit(3) }
                }.padding(.vertical, 4).listRowBackground(Color.clear)
                    .contextMenu { Button("Run history") { history = row }; Button("Edit") { edit(row) } }
            }
        }.listStyle(.plain).scrollContentBackground(.hidden).background(FD.background).navigationTitle("Automations")
            .overlay { if store.rows.isEmpty && !store.loading && error == nil && store.error == nil { ContentUnavailableView("No automations yet", systemImage: "calendar.badge.clock", description: Text("Schedule an agent task to run on your computer.")).allowsHitTesting(false) } }
            .toolbar { Button { editor = AutomationEditorTarget(definition: nil) } label: { Image(systemName: "plus") }.accessibilityLabel("New automation").disabled(!model.connected && !model.demo) }
            .task { await store.refresh(model: model) }.refreshable { await store.refresh(model: model) }
            .onAppear { store.visible += 1 }.onDisappear { store.visible = max(0, store.visible - 1) }
            .sheet(item: $editor) { target in AutomationEditorView(definition: target.definition, settings: store.settings, workspacePath: model.sortedProjects.first?.path ?? "") }
            .sheet(item: $history) { row in AutomationHistoryView(automation: row) }
            .confirmationDialog("Delete automation?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                Button("Delete automation", role: .destructive) { if let row = deleting { run(row, operation: "automation.delete", revision: row.revision) } }
            } message: { Text("Future runs stop. Its agent tasks are kept.") }
    }
    private func edit(_ row: NativeAutomation) {
        guard pending == nil else { return }; pending = row.id; error = nil
        Task {
            defer { pending = nil }
            do { editor = AutomationEditorTarget(definition: try await store.read(row, model: model)) }
            catch { self.error = error.localizedDescription }
        }
    }
    private func run(_ row: NativeAutomation, operation: String, revision: Int? = nil) {
        guard pending == nil else { return }; pending = row.id; error = nil
        Task {
            defer { pending = nil }
            do { try await store.execute(operation, arguments: .object(["automation_id": .string(row.id)]), revision: revision, model: model) }
            catch { self.error = error.localizedDescription }
        }
    }
    private func schedule(_ raw: JSON) -> String {
        if let resolved = raw["resolved_schedule"].string.nonempty { return resolved }
        let trigger = raw["trigger"]
        switch trigger["kind"].string {
        case "interval": return "Every \(trigger["every_seconds"].int / 60) minutes"
        case "once": return AutomationDraft.parseDate(trigger["run_at"].string)?.formatted(date: .abbreviated, time: .shortened) ?? trigger["run_at"].string
        default: return "\(trigger["expression"].string) · \(trigger["timezone"].string)"
        }
    }
}

struct AutomationHistoryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let automation: NativeAutomation
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                if let error { Text(error).foregroundStyle(.orange) }
                if loading { HStack { ActivityDiamond(); Text("Loading run history…") } }
                ForEach(model.automations.runs[automation.id] ?? [], id: \.self) { run in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(run["status"].string.replacingOccurrences(of: "_", with: " ").capitalized).font(.headline)
                        if let date = AutomationDraft.parseDate(run["started_at"].string.nonempty ?? run["queued_at"].string) { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(FD.secondary) }
                        Text(run["outcome_preview"].string.nonempty ?? run["error"]["message"].string).font(.footnote)
                        if let id = run["thread_id"].string.nonempty {
                            Button("Open task") { Task { await model.openTask(id) }; dismiss() }
                        }
                    }.listRowBackground(FD.surface)
                }
                if !loading && (model.automations.runs[automation.id] ?? []).isEmpty { ContentUnavailableView("No runs yet", systemImage: "clock") }
            }.scrollContentBackground(.hidden).background(FD.background).navigationTitle(automation.name).navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Done") { dismiss() } }.task { await load() }.refreshable { await load() }
        }
    }
    private func load() async {
        loading = true; error = nil; defer { loading = false }
        do { try await model.automations.loadRuns(automation.id, model: model) } catch { self.error = error.localizedDescription }
    }
}
