import SwiftUI

struct ComposerView: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    let project: Project?
    @Bindable var chat: ChatSession
    @FocusState private var focused: Bool
    @State private var showGoal = false
    @State private var showModels = false
    @State private var goalSeed = ""
    @State private var goalCommand = ""
    private var models: [AgentModel] { project?.models(for: task.provider) ?? [] }
    private var activeModel: AgentModel? { models.first { $0.id == chat.modelID } ?? models.first { $0.raw["is_default"].bool } ?? models.first }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !model.connected && !model.demo {
                Button { Task { await model.reconnect() } } label: { Label("\(model.status) · Reconnect", systemImage: "wifi.exclamationmark").font(.footnote) }
            }
            SlashCommandsView(task: task, chat: chat) { openGoal() }
            RecordingPanel(task: task, chat: chat)
            if !chat.attachments.isEmpty { AttachmentStrip(chat: chat) }
            TextField(task.running ? "Queue a follow-up…" : "Message \(task.provider.capitalized)…", text: $chat.draft, axis: .vertical)
                .lineLimit(1...6).font(.body).focused($focused).padding(.horizontal, 4).accessibilityIdentifier("chat-input").submitLabel(.return)
                .frame(minHeight: 44, alignment: .topLeading)
                .contentShape(Rectangle())
                .simultaneousGesture(TapGesture().onEnded { focused = true })
            HStack(spacing: 0) {
                if project?.capabilities(task.provider)["supports_images"] != .bool(false) { AttachmentPicker(chat: chat) }
                VoiceControl(task: task, chat: chat)
                Button { focused = false; showModels = true } label: {
                    HStack(spacing: 5) {
                        Text(activeModel?.label ?? chat.modelID.nonempty ?? task.provider.capitalized)
                            .lineLimit(1).truncationMode(.tail)
                        Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                    }.padding(.horizontal, 6).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(.rect)
                }.buttonStyle(.plain).accessibilityLabel("Choose model").accessibilityIdentifier("composer-model")
                ComposerOptions(task: task, project: project, chat: chat)
                if task.running || task.status == "waiting_for_input" {
                    Button { Task { await model.stop(task) } } label: { Image(systemName: "stop.fill").font(.subheadline).frame(width: 44, height: 44).contentShape(.rect) }
                        .buttonStyle(.plain).disabled(chat.stopping || (!model.connected && !model.demo)).accessibilityLabel("Stop task").accessibilityIdentifier("stop-task")
                }
                Button {
                    focused = false
                    if !task.isDraft, chat.draft.trimmingCharacters(in: .whitespacesAndNewlines) == "/goal" || chat.draft.hasPrefix("/goal ") { openGoal() }
                    else { Task { await model.send(task) } }
                } label: {
                    Group { if chat.sending { ActivityDiamond() } else { Image(systemName: task.running ? "arrow.up.to.line" : "arrow.up").fontWeight(.semibold) } }.frame(width: 44, height: 44).contentShape(.rect)
                }
                .background(FD.accent.opacity(chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && chat.attachments.isEmpty ? 0.15 : 1), in: Circle()).buttonStyle(.plain).foregroundStyle(chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && chat.attachments.isEmpty ? FD.secondary : FD.background)
                .disabled(chat.sending || chat.preparingAttachments || (chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && chat.attachments.isEmpty) || (!model.connected && !model.demo))
                .accessibilityLabel(task.running ? "Queue message" : "Send message").accessibilityIdentifier("send-message")
            }.font(.caption).foregroundStyle(FD.secondary)
        }
        .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 6).glassEffect(.regular.tint(FD.surface), in: .rect(cornerRadius: 20))
        .sheet(isPresented: $showModels) {
            NavigationStack {
                Form {
                    Section("Model") {
                        Picker("Model", selection: $chat.modelID) {
                            Text("Task default").tag("")
                            if !chat.modelID.isEmpty && !models.contains(where: { $0.id == chat.modelID }) { Text(chat.modelID).tag(chat.modelID) }
                            ForEach(models) { Text($0.label).tag($0.id) }
                        }.pickerStyle(.inline).labelsHidden()
                    }.listRowBackground(FD.surface)
                    if let activeModel, !activeModel.efforts.isEmpty {
                        Section("Reasoning") {
                            Picker("Reasoning effort", selection: $chat.effort) {
                                Text("Default").tag("")
                                ForEach(activeModel.efforts, id: \.self) { Text($0.capitalized).tag($0) }
                            }.pickerStyle(.inline).labelsHidden()
                        }.listRowBackground(FD.surface)
                    }
                }.scrollContentBackground(.hidden).background(FD.background)
                    .navigationTitle("Model & reasoning").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showModels = false } } }
            }.nativeOptionsSheet()
        }
        .task(id: task.projectID + ":" + task.provider + ":" + String(model.connected)) { await model.loadCatalog(task) }
        .sheet(isPresented: $showGoal) { GoalView(taskID: task.id, initialObjective: goalSeed) { if chat.draft == goalCommand { chat.draft = "" } } }
        .onChange(of: chat.modelID) { _, value in
            chat.effort = ""; chat.overrides["model_id"] = value.isEmpty ? .null : .string(value)
            chat.overrides["reasoning_effort"] = .null
            chat.overrides.removeValue(forKey: "service_tier")
        }
        .onChange(of: chat.effort) { _, value in chat.overrides["reasoning_effort"] = value.isEmpty ? .null : .string(value) }
    }
    private func openGoal() {
        goalCommand = chat.draft
        let text = chat.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        goalSeed = text.hasPrefix("/goal") ? String(text.dropFirst(5)).trimmingCharacters(in: .whitespacesAndNewlines) : ""
        showGoal = true
    }
}
