import SwiftUI

struct ComposerView: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    let project: Project?
    @Bindable var chat: ChatSession
    @FocusState private var focused: Bool
    @State private var selection: TextSelection?
    @State private var voiceSelection: (text: String, indices: Range<String.Index>)?
    @State private var showGoal = false
    @State private var showModels = false
    @State private var goalSeed = ""
    @State private var goalCommand = ""
    private var models: [AgentModel] { project?.models(for: task.provider) ?? [] }
    private var activeModel: AgentModel? { models.first { $0.id == chat.modelID } ?? models.first { $0.raw["is_default"].bool } ?? models.first }
    private var voiceActive: Bool { chat.voiceInputOpen && model.voice.ownerID == task.id }
    private var hasContent: Bool { !chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !chat.attachments.isEmpty }
    private var showsStop: Bool { !hasContent && (task.running || task.status == "waiting_for_input") }
    private var primaryDisabled: Bool {
        if !model.connected && !model.demo { return true }
        return showsStop ? chat.stopping : chat.sending || chat.preparingAttachments || !hasContent
    }
    private var selectionBinding: Binding<TextSelection?> {
        Binding(get: { selection }, set: { value in
            selection = value
            if let value, case .selection(let indices) = value.indices {
                voiceSelection = (chat.draft, indices)
            } else { voiceSelection = nil }
        })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !chat.attachments.isEmpty { AttachmentStrip(chat: chat) }
            if voiceActive {
                RecordingPanel(task: task, chat: chat, onTranscript: receiveTranscript)
            } else {
                SlashCommandsView(task: task, chat: chat) { openGoal() }
                TextField(task.running ? "Queue a follow-up…" : "Message \(task.provider.capitalized)…", text: $chat.draft, selection: selectionBinding, axis: .vertical)
                    .lineLimit(1...6).font(.body).focused($focused).padding(.horizontal, 8).accessibilityIdentifier("chat-input").submitLabel(.return)
                    .frame(minHeight: 44, alignment: .topLeading)
                    .contentShape(Rectangle())
                    .simultaneousGesture(TapGesture().onEnded { focused = true })
                HStack(spacing: 0) {
                    if project?.capabilities(task.provider)["supports_images"] != .bool(false) { AttachmentPicker(chat: chat) }
                    Button { focused = false; showModels = true } label: {
                        HStack(spacing: 5) {
                            Text(activeModel?.label ?? chat.modelID.nonempty ?? task.provider.capitalized)
                                .lineLimit(1).truncationMode(.tail)
                            Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
                        }.font(.subheadline).padding(.horizontal, 6).frame(maxWidth: .infinity, minHeight: ComposerMetrics.controlSize, alignment: .leading).contentShape(.rect)
                    }.buttonStyle(.plain).accessibilityLabel("Choose model").accessibilityIdentifier("composer-model")
                    ComposerOptions(task: task, project: project, chat: chat)
                    VoiceControl(task: task, chat: chat, onBegin: beginVoiceInput)
                    Button {
                        if showsStop { Task { await model.stop(task) } }
                        else { submitDraft() }
                    } label: {
                        Group {
                            if chat.sending || chat.stopping { ActivityDiamond() }
                            else { Image(systemName: showsStop ? "stop.fill" : "arrow.up").font(.system(size: showsStop ? 14 : ComposerMetrics.iconSize, weight: .semibold)) }
                        }.frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize).contentShape(.rect)
                    }
                    .background(showsStop ? FD.foreground : FD.accent.opacity(hasContent ? 1 : 0.15), in: Circle())
                    .buttonStyle(.plain).foregroundStyle(showsStop || hasContent ? FD.background : FD.secondary)
                    .disabled(primaryDisabled)
                    .accessibilityLabel(showsStop ? "Stop task" : task.running ? "Queue message" : "Send message")
                    .accessibilityIdentifier(showsStop ? "stop-task" : "send-message")
                }.foregroundStyle(FD.secondary)
            }
        }
        .padding(.horizontal, 8).padding(.top, 12).padding(.bottom, 8).glassEffect(.regular.tint(FD.surface), in: .rect(cornerRadius: 26))
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
    private func beginVoiceInput() {
        // TextSelection indices can outlive a send or draft edit. Keep their
        // owning text, and validate them once when dictation begins.
        chat.voiceInsertion = voiceSelection.map { VoiceDraftInsertion.capture($0.indices, in: $0.text) } ?? VoiceDraftInsertion(original: chat.draft, selection: nil)
        focused = false
    }
    private func receiveTranscript(_ text: String, submit: Bool) {
        guard let caret = model.finishVoiceInput(text, ownerID: task.id, chat: chat) else { return }
        if submit { submitDraft() }
        else {
            let draft = chat.draft, offset = caret.utf16Offset(in: chat.draft)
            Task { @MainActor in
                // The text field is recreated when the recording panel closes.
                // Apply its caret after focus, so UIKit cannot restore the old
                // selection over the freshly inserted transcript.
                await Task.yield()
                focused = true
                await Task.yield()
                guard !chat.voiceInputOpen, chat.draft.utf16.elementsEqual(draft.utf16) else { return }
                selectionBinding.wrappedValue = TextSelection(insertionPoint: String.Index(utf16Offset: offset, in: chat.draft))
            }
        }
    }
    private func submitDraft() {
        focused = false
        let text = chat.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !task.isDraft && (text == "/goal" || text.hasPrefix("/goal ")) { openGoal() }
        else { Task { await model.send(task) } }
    }
    private func openGoal() {
        goalCommand = chat.draft
        let text = chat.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        goalSeed = text.hasPrefix("/goal") ? String(text.dropFirst(5)).trimmingCharacters(in: .whitespacesAndNewlines) : ""
        showGoal = true
    }
}

enum ComposerMetrics {
    static let controlSize: CGFloat = 48
    static let iconSize: CGFloat = 21
}
