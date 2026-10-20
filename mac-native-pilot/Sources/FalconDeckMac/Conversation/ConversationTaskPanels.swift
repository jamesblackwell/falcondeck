import SwiftUI

func conversationPath(_ task: AgentTask) -> String {
    "/api/workspaces/\(conversationPathComponent(task.projectID))/threads/\(conversationPathComponent(task.id))"
}
func conversationPathComponent(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
}

@MainActor enum ConversationActions {
    @discardableResult static func request(_ store: AppStore, task: AgentTask, suffix: String = "", method: String = "POST", body: JSON? = nil) async throws -> JSON {
        let payload = body.map { $0.setting("workspace_id", .string(task.projectID)).setting("thread_id", .string(task.id)) }
        let result = try await store.request(path: conversationPath(task) + suffix, method: method, body: payload)
        let raw = result["thread"] == .null ? result : result["thread"]
        if raw["id"].string == task.id {
            if let index = store.tasks.firstIndex(where: { $0.id == task.id }), store.tasks[index].updatedAt <= raw["updated_at"].string {
                store.tasks[index] = AgentTask(raw)
            }
        }
        return result
    }

    static func adopt(_ store: AppStore, result: JSON) async {
        let task = AgentTask(result["thread"])
        guard !task.id.isEmpty else { return }
        await store.acceptTask(result)
    }
}

struct ConversationTaskPanels: View {
    let store: AppStore
    let task: AgentTask
    let capabilities: JSON
    @State private var showGoal = false
    @State private var expandedPlan = false
    @State private var editingQueue: JSON?
    @State private var queuedText = ""
    @State private var pending = false
    @State private var actionError: String?

    private var queued: [JSON] { task.raw["queued_turns"].array }
    private var goal: JSON { task.raw["goal"] }
    private var plan: JSON { task.raw["latest_plan"] }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if goal != .null {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "scope").foregroundStyle(FDTheme.accent)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(goal["objective"].string).font(NativePreferences.shared.font(size: 14, surface: "chat", weight: .medium)).lineLimit(2)
                        HStack(spacing: 8) {
                            Text(goal["status"].string.capitalized)
                            if goal["token_budget"].int > 0 {
                                Text("\(goal["tokens_used"].int.formatted()) / \(goal["token_budget"].int.formatted()) tokens")
                            }
                        }.font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
                    }
                    Spacer()
                    Menu {
                        Button("Edit goal") { showGoal = true }
                        if ConversationActionSemantics.canSetGoalStatus(task) {
                            Button(goal["status"].string == "paused" ? "Resume goal" : "Pause goal") {
                                run { _ = try await ConversationActions.request(store, task: task, suffix: "/goal", body: .object(["status": .string(goal["status"].string == "paused" ? "active" : "paused")])) }
                            }
                        }
                        Button("Clear goal", role: .destructive) {
                            run { _ = try await ConversationActions.request(store, task: task, suffix: "/goal", method: "DELETE") }
                        }
                    } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize()
                }.padding(12).background(FDTheme.accentDim, in: .rect(cornerRadius: 9))
            }
            if !plan["steps"].array.isEmpty {
                DisclosureGroup(isExpanded: $expandedPlan) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(plan["steps"].array, id: \.self) { step in
                            Label(step["step"].string, systemImage: step["status"].string == "completed" ? "checkmark.circle.fill" : step["status"].string == "in_progress" ? "circle.lefthalf.filled" : "circle")
                                .font(NativePreferences.shared.font(size: 13, surface: "chat")).foregroundStyle(step["status"].string == "completed" ? FDTheme.muted : FDTheme.secondary)
                        }
                    }.padding(.vertical, 8)
                } label: {
                    Label("Plan · \(plan["steps"].array.filter { $0["status"].string == "completed" }.count) of \(plan["steps"].array.count)", systemImage: "checklist")
                        .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
                }
            }
            if !queued.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("QUEUED FOLLOW-UPS · \(queued.count)").font(NativePreferences.shared.font(size: 11, surface: "code", weight: .medium)).foregroundStyle(FDTheme.muted)
                    ForEach(Array(queued.enumerated()), id: \.element) { index, item in
                        HStack(spacing: 9) {
                            Text("\(index + 1)").font(NativePreferences.shared.font(size: 12, surface: "code")).foregroundStyle(FDTheme.subtle)
                            Text(item["preview"].string.isEmpty ? "Attachment" : item["preview"].string).font(NativePreferences.shared.font(size: 14, surface: "chat")).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                            if item["attachment_count"].int > 0 { Label("\(item["attachment_count"].int)", systemImage: "paperclip").font(NativePreferences.shared.font(size: 12)) }
                            Menu {
                                Button("Edit message") { queuedText = item["text"].string.isEmpty ? item["preview"].string : item["text"].string; editingQueue = item }
                                if capabilities["supports_steering"].bool && task.running { Button("Steer current turn") { queueAction(item, action: "steer") } }
                                if index > 0 { Button("Move up") { reorder(index, by: -1) } }
                                if index < queued.count - 1 { Button("Move down") { reorder(index, by: 1) } }
                                Button("Remove", role: .destructive) { queueAction(item, action: "remove") }
                            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize()
                        }
                    }
                }.padding(12).background(FDTheme.surface, in: .rect(cornerRadius: 9))
            }
            if task.status == "error" && task.raw["last_error"].string == "FalconDeck was closed while this turn was running" {
                HStack {
                    Label("This task stopped when FalconDeck closed.", systemImage: "pause.circle")
                    Spacer()
                    Button("Resume") {
                        run { _ = try await ConversationActions.request(store, task: task, suffix: "/turns", body: .object(["inputs": .array([]), "resume_interrupted": .bool(true)])) }
                    }
                }.font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            }
            if task.raw["handoff_from"]["context_pending"].bool {
                Label("Conversation context will be included with your next message.", systemImage: "arrow.triangle.branch")
                    .font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            }
            if let actionError { Text(actionError).font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.warning).textSelection(.enabled) }
        }
        .disabled(pending || !store.isSelectedHostConnected)
        .sheet(isPresented: $showGoal) { ConversationGoalEditor(store: store, task: task) }
        .sheet(isPresented: Binding(get: { editingQueue != nil }, set: { if !$0 { editingQueue = nil } })) {
            VStack(alignment: .leading, spacing: 16) {
                Text("Edit queued message").font(NativePreferences.shared.font(size: 17, weight: .semibold))
                TextEditor(text: $queuedText).font(NativePreferences.shared.font(size: 15, surface: "chat")).frame(width: 500, height: 180)
                HStack { Spacer(); Button("Cancel") { editingQueue = nil }; Button("Save") {
                    guard let item = editingQueue else { return }
                    queueAction(item, action: "edit", text: queuedText)
                    editingQueue = nil
                }.keyboardShortcut(.defaultAction).disabled(queuedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }.padding(24)
        }
    }

    private func queueAction(_ item: JSON, action: String, text: String? = nil) {
        run {
            let suffix = "/queue/" + conversationPathComponent(item["id"].string) + (action == "steer" ? "/steer" : "")
            _ = try await ConversationActions.request(store, task: task, suffix: suffix, method: action == "remove" ? "DELETE" : action == "edit" ? "PATCH" : "POST", body: text.map { .object(["text": .string($0)]) })
        }
    }
    private func reorder(_ index: Int, by delta: Int) {
        var values = queued
        values.swapAt(index, index + delta)
        run { _ = try await ConversationActions.request(store, task: task, suffix: "/queue/reorder", body: .object(["queued_ids": .array(values.map { $0["id"] })])) }
    }
    private func run(_ operation: @escaping () async throws -> Void) {
        guard !pending else { return }; pending = true; actionError = nil
        Task { defer { pending = false }; do { try await operation() } catch { actionError = error.localizedDescription } }
    }
}

struct ConversationGoalEditor: View {
    let store: AppStore
    let task: AgentTask
    @Environment(\.dismiss) private var dismiss
    @State private var objective = ""
    @State private var budget = ""
    @State private var pending = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(task.raw["goal"] == .null ? "Set a goal" : "Edit goal").font(NativePreferences.shared.font(size: 19, weight: .semibold))
            Text("The agent keeps working towards this objective across turns.").font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.muted)
            TextEditor(text: $objective).frame(height: 120).font(NativePreferences.shared.font(size: 15, surface: "chat"))
            if task.provider == "codex" { TextField("Optional token budget", text: $budget).textFieldStyle(.roundedBorder) }
            if let error { Text(error).font(NativePreferences.shared.font(size: 12)).foregroundStyle(FDTheme.warning) }
            HStack { Spacer(); Button("Cancel") { dismiss() }; Button("Save goal", action: save).keyboardShortcut(.defaultAction)
                    .disabled(pending || objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        }.padding(24).frame(width: 500)
            .onAppear { objective = task.raw["goal"]["objective"].string; if task.raw["goal"]["token_budget"].int > 0 { budget = String(task.raw["goal"]["token_budget"].int) } }
    }
    private func save() {
        if !budget.isEmpty, Int(budget).map({ $0 > 0 }) != true { error = "Enter a positive token budget."; return }
        pending = true; error = nil
        let text = objective.trimmingCharacters(in: .whitespacesAndNewlines)
        var fields: [String: JSON] = ["objective": .string(text)]
        if let value = Int(budget), value > 0 { fields["token_budget"] = .number(Double(value)) }
        Task {
            defer { pending = false }
            do { _ = try await ConversationActions.request(store, task: task, suffix: "/goal", body: .object(fields)); dismiss() }
            catch { self.error = error.localizedDescription }
        }
    }
}
