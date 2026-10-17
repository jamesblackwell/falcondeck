import SwiftUI

struct QueuedMessagesView: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    @State private var editingID: String?
    @State private var text = ""
    @State private var pending = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(task.queued, id: \.self) { queued in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "text.line.first.and.arrowtriangle.forward").foregroundStyle(FD.secondary)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(queued["text"].string.nonempty ?? queued["preview"].string).font(.footnote).lineLimit(3)
                        if queued["attachment_count"].int > 0 { Text("\(queued["attachment_count"].int) attachments").font(.caption).foregroundStyle(FD.secondary) }
                    }
                    Spacer(minLength: 0)
                    Menu {
                        Button("Edit message", systemImage: "pencil") { text = queued["text"].string.nonempty ?? queued["preview"].string; editingID = queued["id"].string }
                        if model.projects.first(where: { $0.id == task.projectID })?.capabilities(task.provider)["supports_steering"].bool == true {
                            Button("Send now", systemImage: "arrow.up") { run(queued, action: "steer") }
                        }
                        Button("Remove", systemImage: "trash", role: .destructive) { run(queued, action: "remove") }
                    } label: { Image(systemName: "ellipsis").padding(6) }
                }.padding(10).background(FD.surface, in: .rect(cornerRadius: 12))
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.orange) }
        }.disabled(pending || (!model.demo && !model.connected))
        .alert("Edit queued message", isPresented: Binding(get: { editingID != nil }, set: { if !$0 { editingID = nil } })) {
            TextField("Message", text: $text, axis: .vertical)
            Button("Cancel", role: .cancel) { editingID = nil }
            Button("Save") {
                if let id = editingID { run(.object(["id": .string(id)]), action: "edit", text: text) }
                editingID = nil
            }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
    private func run(_ queued: JSON, action: String, text: String? = nil) {
        guard !pending else { return }; pending = true; error = nil
        Task {
            defer { pending = false }
            do { try await model.queueAction(task, queuedID: queued["id"].string, action: action, text: text) }
            catch { self.error = error.localizedDescription }
        }
    }
}
