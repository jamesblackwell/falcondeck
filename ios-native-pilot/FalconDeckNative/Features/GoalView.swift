import SwiftUI

struct GoalView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let taskID: String
    var initialObjective = ""
    var onSaved: (() -> Void)? = nil
    @State private var objective = ""
    @State private var budget = ""
    @State private var pending = false
    @State private var error: String?
    private var task: AgentTask? { model.task(taskID) }
    var body: some View {
        NavigationStack {
            Form {
                if let task {
                    if task.goal != .null {
                        Section {
                            Text(task.goal["objective"].string).textSelection(.enabled)
                            LabeledContent("Status", value: task.goal["status"].string.capitalized)
                            if let tokens = task.goal["tokens_used"].optionalInt { LabeledContent("Tokens used", value: tokens.formatted()) }
                            if let limit = task.goal["token_budget"].optionalInt { LabeledContent("Token budget", value: limit.formatted()) }
                            if let seconds = task.goal["time_used_seconds"].optionalInt { LabeledContent("Elapsed", value: Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .abbreviated))) }
                        }.listRowBackground(FD.surface)
                        if task.provider == "codex", task.goal["status"].string != "complete" {
                            Section {
                                Button(task.goal["status"].string == "paused" ? "Resume goal" : "Pause goal") {
                                    run { try await model.setGoal(task, status: task.goal["status"].string == "paused" ? "active" : "paused") }
                                }
                            }.listRowBackground(FD.surface)
                        }
                    } else {
                        Section("What should the agent accomplish?") {
                            TextField("Goal objective", text: $objective, axis: .vertical).lineLimit(3...10).accessibilityIdentifier("goal-objective")
                            if task.provider == "codex" { TextField("Token budget (optional)", text: $budget).keyboardType(.numberPad) }
                        }.listRowBackground(FD.surface)
                        Section {
                            Button("Start goal") {
                                run { try await model.setGoal(task, objective: objective.trimmingCharacters(in: .whitespacesAndNewlines), budget: Int(budget).flatMap { $0 > 0 ? $0 : nil }); onSaved?() }
                            }.disabled(objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("start-goal")
                        }.listRowBackground(FD.surface)
                    }
                }
                if let error { Text(error).foregroundStyle(.orange).listRowBackground(FD.surface) }
            }
            .disabled(pending || (!model.connected && !model.demo))
            .scrollContentBackground(.hidden).background(FD.background)
            .navigationTitle("Goal").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let task, task.goal != .null {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Delete goal", role: .destructive) { run { try await model.setGoal(task, clear: true) } }
                            .disabled(pending || (!model.connected && !model.demo))
                            .accessibilityIdentifier("delete-goal")
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(pending) }
            }
        }.onAppear { if objective.isEmpty { objective = initialObjective } }.nativeOptionsSheet().interactiveDismissDisabled(pending)
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !pending else { return }
        pending = true; error = nil
        Task {
            defer { pending = false }
            do { try await action(); dismiss() } catch { self.error = error.localizedDescription }
        }
    }
}
