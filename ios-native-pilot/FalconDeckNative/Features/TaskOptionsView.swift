import SwiftUI

struct TaskOptionsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let taskID: String
    @State private var title = ""
    @State private var pending = false
    @State private var error: String?
    @State private var goal = false
    @State private var compact = false
    @State private var instructions = ""
    private var task: AgentTask? { model.task(taskID) }
    private var canMutate: Bool { model.demo || model.connected }
    var body: some View {
        NavigationStack {
            Form {
                if let task {
                    Group {
                        Section {
                            DisclosureGroup("Rename task") {
                            TextField("Task title", text: $title).accessibilityIdentifier("task-title")
                            Button("Save title") { run { _ = try await model.taskRequest(task, method: "thread.update", fields: ["title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines))]) } }
                                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            Button("Suggest a title", systemImage: "sparkles") {
                                run(close: false) {
                                    if model.demo { title = "A fresh native experience" }
                                    else {
                                        let result = try await model.taskRequest(task, method: "thread.suggestTitle")
                                        guard !result["title"].string.isEmpty else { throw PilotError("Couldn't generate a title.") }
                                        title = result["title"].string
                                    }
                                }
                            }
                            }
                        }.listRowBackground(FD.surface).disabled(!canMutate)
                        Section {
                            TaskStageMenu(task: task)
                            Button(task.pinned ? "Unpin" : "Pin", systemImage: "pin") { run { _ = try await model.taskRequest(task, method: "thread.update", fields: ["pinned": .bool(!task.pinned)]) } }
                            Button(task.pinnedInProject ? "Unpin in project" : "Pin in project", systemImage: "pin.circle") { run { _ = try await model.taskRequest(task, method: "thread.update", fields: ["pinned_in_project": .bool(!task.pinnedInProject)]) } }
                            Menu("Move to folder", systemImage: "folder") {
                                Button("Project root") { move(task, folder: nil) }
                                ForEach(model.folders.filter { $0.projectID == task.projectID }) { folder in Button(folder.name) { move(task, folder: folder.id) } }
                            }
                            TaskReadButton(task: task) {
                                run {
                                    guard await model.markRead(task, unread: !task.unread) else { throw PilotError(model.error ?? "Couldn't update the task's read status.") }
                                }
                            }
                        }.listRowBackground(FD.surface).disabled(!canMutate)
                        Section {
                            if task.goal != .null || model.projects.first(where: { $0.id == task.projectID })?.capabilities(task.provider)["supports_goals"].bool == true || model.demo {
                                Button(task.goal == .null ? "Set a goal" : "View goal", systemImage: "target") { goal = true }.disabled(task.goal == .null && !canMutate)
                            }
                            if model.projects.first(where: { $0.id == task.projectID })?.capabilities(task.provider)["supports_compaction"].bool == true || model.demo {
                                Button("Compact context", systemImage: "arrow.down.right.and.arrow.up.left") { compact = true }.disabled(!canMutate || task.running || task.status == "waiting_for_input")
                            }
                            let chat = model.chat(for: task)
                            ShareLink(item: ExportedText(text: TranscriptExport.markdown(chat.transcript.items, title: task.title, partial: chat.hasOlder), title: task.title), preview: SharePreview(task.title)) {
                                Label(chat.loading ? "Loading conversation…" : chat.hasOlder ? "Share loaded conversation" : "Share conversation", systemImage: "square.and.arrow.up")
                            }.disabled(!chat.loaded || chat.loading || chat.transcript.items.isEmpty).accessibilityIdentifier("share-conversation")
                            if let error = chat.historyError {
                                Text(error).font(.footnote).foregroundStyle(.orange)
                                Button("Retry loading conversation") { Task { await model.loadChat(task) } }.disabled(!canMutate)
                            }

                            if let project = model.projects.first(where: { $0.id == task.projectID }), project.providers.contains(where: { $0 != task.provider }) {
                                Menu("Continue with another agent", systemImage: "arrow.triangle.branch") {
                                    ForEach(project.providers.filter { $0 != task.provider }, id: \.self) { provider in
                                        Button(provider.capitalized) { run { try await model.handoff(task, provider: provider) } }
                                    }
                                }.disabled(!canMutate)
                            }
                            if task.archived { Button("Restore task", systemImage: "arrow.uturn.backward") { run { try await model.unarchive(task) } }.disabled(!canMutate) }
                            else { Button("Archive task", systemImage: "archivebox", role: .destructive) { run { await model.archive(task) } }.disabled(!canMutate) }
                        }.listRowBackground(FD.surface)
                    }
                }
                if let task {
                    if !model.demo || ProcessInfo.processInfo.arguments.contains("--task-activity-preview") {
                        Section {
                            if model.taskActivity.isTracking(task.id) {
                                Button("Hide from Lock Screen", systemImage: "lock.slash") { model.taskActivity.stop() }
                                    .accessibilityIdentifier("task-live-activity")
                                    .accessibilityValue(model.taskActivity.record?.state.connected == false ? "Last known status" : model.taskActivity.record?.state.phase.label ?? "")
                            } else {
                                Button("Show on Lock Screen", systemImage: "lock.rectangle") {
                                    do { try model.followOnLockScreen(task) } catch { self.error = error.localizedDescription }
                                }.disabled(!model.taskActivity.enabled || !canMutate || !(task.running || task.awaitingInput))
                                    .accessibilityIdentifier("task-live-activity")
                            }
                        } footer: {
                            Text(activityHelp(task))
                        }.listRowBackground(FD.surface)
                    }
                    // These presentation controls stay available offline.
                    if ConversationPreferences(raw: model.preferences["conversation"]).flag("show_expand_all_controls") {
                        Section("Transcript") {
                            Button("Expand all activity") { model.chat(for: task).transcriptExpansion = TranscriptExpansion(expanded: true) }
                            Button("Collapse all activity") { model.chat(for: task).transcriptExpansion = TranscriptExpansion(expanded: false) }
                        }.listRowBackground(FD.surface)
                    }
                    TaskUsageView(usage: model.tokenUsage[task.id])
                }
                if let error { Text(error).foregroundStyle(.orange).listRowBackground(FD.surface) }
            }
            .disabled(pending)
            .scrollContentBackground(.hidden).background(FD.background).navigationTitle("Task options").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(pending) } }
            .onAppear { title = task?.title ?? ""; model.taskActivity.reconcileDismissal() }
            .task(id: "\(taskID):\(canMutate)") { if canMutate, let task, !model.chat(for: task).loaded || model.chat(for: task).needsRefresh { await model.loadChat(task) } }
            .sheet(isPresented: $goal) { GoalView(taskID: taskID) }
            .alert("Compact context", isPresented: $compact) {
                TextField("Guidance (optional)", text: $instructions)
                Button("Cancel", role: .cancel) { }
                Button("Compact") { if let task { run { try await model.compact(task, instructions: instructions) } } }
            } message: { Text("Ask the agent to condense this task's context. The original conversation stays in its native storage.") }
        }.presentationDetents([.large]).interactiveDismissDisabled(pending)
    }
    private func activityHelp(_ task: AgentTask) -> String {
        if !model.taskActivity.enabled { return "Allow Live Activities for Falcon Native in iOS Settings." }
        if !model.taskActivity.isTracking(task.id) {
            if !canMutate { return "Connect to your computer to follow this task on the Lock Screen." }
            if !task.running && !task.awaitingInput { return "Available while a task is working or needs your input." }
        }
        return "Follow one task on this device. Status updates while the app is connected; otherwise the card shows the last known status. Tap it to return here."
    }
    private func move(_ task: AgentTask, folder: String?) { run { try await model.folderMutation(projectID: task.projectID, action: "move_thread", folderID: folder, taskID: task.id) } }
    private func run(close: Bool = true, _ action: @escaping @MainActor () async throws -> Void) {
        guard !pending else { return }; pending = true; error = nil
        Task {
            defer { pending = false }
            do { try await action(); if close { dismiss() } } catch { self.error = error.localizedDescription }
        }
    }
}

struct ArchivedTasksView: View {
    @Environment(AppModel.self) private var model
    @State private var error: String?
    @State private var pending: String?
    @State private var search = ""
    @State private var loading = false
    @State private var hasLoaded = false
    private var filtered: [AgentTask] { model.archivedTasks.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) } }
    var body: some View {
        List {
            if let error, !model.archivedTasks.isEmpty { Text(error).font(.footnote).foregroundStyle(.orange) }
            ForEach(filtered) { task in
                HStack {
                    Button { model.selection = .task(task.id) } label: { VStack(alignment: .leading) { Text(task.title); Text(task.provider.capitalized).font(.caption).foregroundStyle(FD.secondary) }.frame(maxWidth: .infinity, alignment: .leading) }.buttonStyle(.plain)
                    Spacer()
                    Button("Restore") {
                        pending = task.id
                        Task {
                            defer { pending = nil }
                            do { try await model.unarchive(task) } catch { self.error = error.localizedDescription }
                        }
                    }.disabled(pending != nil || (!model.demo && !model.connected))
                }.listRowBackground(FD.surface)
            }
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Archived tasks")
            .overlay {
                if model.archivedTasks.isEmpty && (loading || !hasLoaded) {
                    ActivityDiamond().accessibilityLabel("Loading archived tasks")
                } else if model.archivedTasks.isEmpty, let error {
                    ContentUnavailableView {
                        Label("Couldn't load archived tasks", systemImage: "wifi.exclamationmark")
                    } description: { Text(error) } actions: {
                        Button("Retry") { Task { await load() } }.disabled(!model.demo && !model.connected)
                    }
                } else if !search.isEmpty && filtered.isEmpty { ContentUnavailableView.search(text: search).allowsHitTesting(false) }
                else if model.archivedTasks.isEmpty { ContentUnavailableView("No archived tasks", systemImage: "archivebox").allowsHitTesting(false) }
            }
            .searchable(text: $search).task { await load() }.refreshable { await load() }
    }
    private func load() async {
        guard !loading else { return }; loading = true; error = nil
        defer { loading = false; hasLoaded = true }
        do { try await model.loadArchived() } catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
    }
}
