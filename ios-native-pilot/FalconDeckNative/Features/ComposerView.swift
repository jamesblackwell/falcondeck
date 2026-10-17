import SwiftUI

struct ComposerView: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    let project: Project?
    @Bindable var chat: ChatSession
    @FocusState private var focused: Bool
    private var models: [AgentModel] { project?.models(for: task.provider) ?? [] }
    private var activeModel: AgentModel? { models.first { $0.id == chat.modelID } ?? models.first { $0.raw["is_default"].bool } ?? models.first }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !model.connected && !model.demo {
                Button { Task { await model.reconnect() } } label: { Label("\(model.status) · Reconnect", systemImage: "wifi.exclamationmark").font(.footnote) }
            }
            RecordingPanel(task: task, chat: chat)
            if !chat.attachments.isEmpty { AttachmentStrip(chat: chat) }
            TextField(task.running ? "Queue a follow-up…" : "Message \(task.provider.capitalized)…", text: $chat.draft, axis: .vertical)
                .lineLimit(1...7).font(.body).focused($focused).padding(.horizontal, 4).accessibilityIdentifier("chat-input").submitLabel(.return)
            HStack(spacing: 12) {
                if project?.capabilities(task.provider)["supports_images"] != .bool(false) { AttachmentPicker(chat: chat) }
                VoiceControl(task: task, chat: chat)
                Menu {
                    Picker("Model", selection: $chat.modelID) {
                        Text("Task default").tag("")
                        if !chat.modelID.isEmpty && !models.contains(where: { $0.id == chat.modelID }) { Text(chat.modelID).tag(chat.modelID) }
                        ForEach(models) { Text($0.label).tag($0.id) }
                    }
                } label: {
                    HStack(spacing: 4) { Text(models.first { $0.id == chat.modelID }?.label ?? chat.modelID.nonempty ?? task.provider.capitalized).lineLimit(1); Image(systemName: "chevron.down").font(.caption2) }
                }.accessibilityLabel("Choose model")
                Menu {
                    Picker("Reasoning", selection: $chat.effort) {
                        Text("Default effort").tag("")
                        ForEach(activeModel?.efforts ?? [], id: \.self) { Text($0.capitalized).tag($0) }
                    }
                } label: { HStack(spacing: 4) { Text(chat.effort.nonempty?.capitalized ?? "Effort"); Image(systemName: "chevron.down").font(.caption2) } }
                    .disabled(activeModel?.efforts.isEmpty != false)
                ComposerOptions(task: task, project: project, chat: chat)
                Spacer(minLength: 0)
                if task.running || task.status == "waiting_for_input" {
                    Button { Task { await model.stop(task) } } label: { Image(systemName: "stop.fill").font(.subheadline).frame(width: 32, height: 32) }
                        .buttonStyle(.glass).disabled(chat.stopping || (!model.connected && !model.demo)).accessibilityLabel("Stop task").accessibilityIdentifier("stop-task")
                }
                Button {
                    focused = false
                    Task { await model.send(task) }
                } label: {
                    Group { if chat.sending { ActivityDiamond() } else { Image(systemName: task.running ? "arrow.up.to.line" : "arrow.up").fontWeight(.semibold) } }.frame(width: 32, height: 32)
                }
                .buttonStyle(.glassProminent).tint(FD.accent).foregroundStyle(FD.background)
                .disabled(chat.sending || chat.preparingAttachments || (chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && chat.attachments.isEmpty) || (!model.connected && !model.demo))
                .accessibilityLabel(task.running ? "Queue message" : "Send message").accessibilityIdentifier("send-message")
            }.font(.caption).foregroundStyle(FD.secondary)
            if model.demo { Text("Demo · Messages stay on this device").font(.caption2).foregroundStyle(FD.muted) }
        }
        .padding(14).glassEffect(in: .rect(cornerRadius: 24))
        .onChange(of: chat.modelID) { _, value in
            chat.effort = ""; chat.overrides["model_id"] = value.isEmpty ? .null : .string(value)
            chat.overrides["reasoning_effort"] = .null
            chat.overrides.removeValue(forKey: "service_tier")
        }
        .onChange(of: chat.effort) { _, value in chat.overrides["reasoning_effort"] = value.isEmpty ? .null : .string(value) }
    }
}
