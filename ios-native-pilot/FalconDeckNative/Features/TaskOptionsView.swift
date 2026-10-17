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
    var body: some View {
        NavigationStack {
            Form {
                if let task {
                    Section("Task title") {
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
                    }.listRowBackground(FD.surface)
                    Section {
                        Button(task.pinned ? "Unpin" : "Pin", systemImage: "pin") { run { _ = try await model.taskRequest(task, method: "thread.update", fields: ["pinned": .bool(!task.pinned)]) } }
                        Button(task.pinnedInProject ? "Unpin in project" : "Pin in project", systemImage: "pin.circle") { run { _ = try await model.taskRequest(task, method: "thread.update", fields: ["pinned_in_project": .bool(!task.pinnedInProject)]) } }
                        Menu("Move to folder", systemImage: "folder") {
                            Button("Project root") { move(task, folder: nil) }
                            ForEach(model.folders.filter { $0.projectID == task.projectID }) { folder in Button(folder.name) { move(task, folder: folder.id) } }
                        }
                        if task.activitySeq > 0 { Button(task.unread ? "Mark read" : "Mark unread", systemImage: "circle") { run { await model.markRead(task, unread: !task.unread) } } }
                    }.listRowBackground(FD.surface)
                    Section {
                        if task.goal != .null || model.projects.first(where: { $0.id == task.projectID })?.capabilities(task.provider)["supports_goals"].bool == true || model.demo {
                            Button(task.goal == .null ? "Set a goal" : "View goal", systemImage: "target") { goal = true }
                        }
                        if model.projects.first(where: { $0.id == task.projectID })?.capabilities(task.provider)["supports_compaction"].bool == true || model.demo {
                            Button("Compact context", systemImage: "arrow.down.right.and.arrow.up.left") { compact = true }.disabled(task.running || task.status == "waiting_for_input")
                        }
                        let chat = model.chat(for: task)
                        ShareLink(item: ExportedText(text: TranscriptExport.markdown(chat.transcript.items, title: task.title, partial: chat.hasOlder), title: task.title), preview: SharePreview(task.title)) {
                            Label(chat.loading ? "Loading conversation…" : chat.hasOlder ? "Share loaded conversation" : "Share conversation", systemImage: "square.and.arrow.up")
                        }.disabled(!chat.loaded || chat.loading || chat.transcript.items.isEmpty)
                        if let error = chat.error, !chat.loaded {
                            Text(error).font(.footnote).foregroundStyle(.orange)
                            Button("Retry loading conversation") { Task { await model.loadChat(task) } }
                        }

                        Button("Archive task", systemImage: "archivebox", role: .destructive) { run { await model.archive(task) } }
                    }.listRowBackground(FD.surface)
                }
                if let error { Text(error).foregroundStyle(.orange).listRowBackground(FD.surface) }
            }
            .disabled(pending || (!model.demo && !model.connected))
            .scrollContentBackground(.hidden).background(FD.background).navigationTitle("Task options").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(pending) } }
            .onAppear { title = task?.title ?? "" }
            .task(id: taskID) { if let task, !model.chat(for: task).loaded { await model.loadChat(task) } }
            .sheet(isPresented: $goal) { GoalView(taskID: taskID) }
            .alert("Compact context", isPresented: $compact) {
                TextField("Guidance (optional)", text: $instructions)
                Button("Cancel", role: .cancel) { }
                Button("Compact") { if let task { run { try await model.compact(task, instructions: instructions) } } }
            } message: { Text("Ask the agent to condense this task's context. The original conversation stays in its native storage.") }
        }.presentationDetents([.large]).interactiveDismissDisabled(pending)
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
    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.orange) }
            ForEach(model.archivedTasks.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }) { task in
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
            if model.archivedTasks.isEmpty { ContentUnavailableView("No archived tasks", systemImage: "archivebox") }
        }.scrollContentBackground(.hidden).background(FD.background).navigationTitle("Archived tasks")
            .searchable(text: $search).task { await load() }.refreshable { await load() }
    }
    private func load() async { do { try await model.loadArchived() } catch { self.error = error.localizedDescription } }
}
