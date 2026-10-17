import SwiftUI

private struct QueuedMessageRow: Identifiable {
    let raw: JSON
    var id: String { raw["id"].string }
}

struct QueuedMessagesView: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    @State private var pending = false
    @State private var error: String?
    var body: some View {
        let queue = (task.queued + model.chat(for: task).pendingQueue.map(\.json)).map { QueuedMessageRow(raw: $0) }
        VStack(alignment: .leading, spacing: 8) {
            ForEach(queue) { row in
                let queued = row.raw
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "text.line.first.and.arrowtriangle.forward").foregroundStyle(FD.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(queued["text"].string.nonempty ?? queued["preview"].string).font(.footnote).lineLimit(3)
                        let count = queued["attachment_count"].int
                        if count > 0 { Text("\(count) \(count == 1 ? "attachment" : "attachments")").font(.caption).foregroundStyle(FD.secondary) }
                    }
                    Spacer(minLength: 0)
                    if queued["pending"].bool { ActivityDiamond().frame(width: 44, height: 44) }
                    else {
                        Menu {
                            Button("Edit message", systemImage: "pencil") {
                                model.chat(for: task).queuedEdit = QueuedMessageEdit(id: row.id, text: queued["text"] == .null ? queued["preview"].string : queued["text"].string)
                            }
                            if model.projects.first(where: { $0.id == task.projectID })?.capabilities(task.provider)["supports_steering"].bool == true {
                                Button("Send now", systemImage: "arrow.up") { run(queued, action: "steer") }
                            }
                            Button("Remove", systemImage: "trash", role: .destructive) { run(queued, action: "remove") }
                        } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(.rect) }
                            .accessibilityLabel("Queued message options").accessibilityIdentifier("queued-options-\(row.id)")
                    }
                }.padding(10).background(FD.surface, in: .rect(cornerRadius: 12))
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.orange) }
        }.disabled(pending || (!model.demo && !model.connected))
    }
    private func run(_ queued: JSON, action: String) {
        guard !pending else { return }; pending = true; error = nil
        Task {
            defer { pending = false }
            do { try await model.queueAction(task, queuedID: queued["id"].string, action: action) }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct QueuedMessageEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let task: AgentTask
    let edit: QueuedMessageEdit
    @State private var text: String
    @State private var pending = false
    @State private var error: String?
    private var exists: Bool { model.task(task.id)?.queued.contains { $0["id"].string == edit.id } == true }
    init(task: AgentTask, edit: QueuedMessageEdit) {
        self.task = task; self.edit = edit; _text = State(initialValue: edit.text)
    }
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                TextEditor(text: $text).frame(maxWidth: .infinity, maxHeight: .infinity)
                    .scrollContentBackground(.hidden).accessibilityLabel("Queued message").accessibilityIdentifier("queued-message-text")
                if !exists {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("This message has already been sent or removed. You can copy your edits.").font(.footnote).foregroundStyle(FD.secondary)
                        Button("Copy edited message", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                    }.padding(.bottom, 8)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.orange).padding(.bottom, 8) }
            }.disabled(pending).scrollDismissesKeyboard(.interactively)
                .padding(.horizontal, FD.inset).padding(.top, 8).background(FD.background)
                .navigationTitle("Edit message").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(pending).keyboardShortcut(.escape, modifiers: []) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { save() }.accessibilityIdentifier("save-queued-message")
                            .disabled(pending || !exists || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (!model.demo && !model.connected))
                    }
                }
        }.presentationDetents([.large]).interactiveDismissDisabled(pending)
    }
    private func save() {
        guard !pending, exists, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, model.demo || model.connected else { return }; pending = true; error = nil
        Task {
            defer { pending = false }
            do { try await model.queueAction(model.task(task.id) ?? task, queuedID: edit.id, action: "edit", text: text); dismiss() }
            catch { self.error = error.localizedDescription }
        }
    }
}
