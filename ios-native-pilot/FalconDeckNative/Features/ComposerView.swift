import SwiftUI

struct ComposerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.nativeMotion) private var motion
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
    @State private var transcriptFeedback = 0
    private var models: [AgentModel] { model.effectiveModels(projectID: task.projectID, provider: task.provider) }
    private var providerLabel: String { (model.projects.first { $0.id == task.projectID } ?? project)?.providerLabel(task.provider) ?? task.provider.capitalized }
    private var activeModel: AgentModel? { AgentModel.resolve(models: models, provider: task.provider, id: chat.modelID) }
    private var modelLoadScope: String { "\(model.connectionID):\(task.projectID):\(task.provider):\(model.connected):\(model.projects.first { $0.id == task.projectID }?.models(for: task.provider).isEmpty ?? true)" }
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
                TextField(task.running ? "Queue a follow-up…" : "Message \(providerLabel)…", text: $chat.draft, selection: selectionBinding, axis: .vertical)
                    .lineLimit(1...6).font(.body).focused($focused).padding(.horizontal, 8).accessibilityIdentifier("chat-input").submitLabel(.return)
                    .frame(minHeight: 44, alignment: .topLeading)
                    .contentShape(Rectangle())
                    .simultaneousGesture(TapGesture().onEnded { focused = true })
                HStack(spacing: 0) {
                    if project?.capabilities(task.provider)["supports_images"] != .bool(false) { AttachmentPicker(chat: chat) }
                    Button { focused = false; showModels = true } label: {
                        HStack(spacing: 5) {
                            Text(activeModel?.label ?? chat.modelID.nonempty ?? providerLabel)
                                .lineLimit(1).truncationMode(.tail)
                            Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
                        }.font(.subheadline).padding(.horizontal, 6).frame(maxWidth: .infinity, minHeight: ComposerMetrics.controlSize, alignment: .leading).contentShape(.rect)
                    }.buttonStyle(ComposerControlStyle(role: .model)).accessibilityLabel("Choose model").accessibilityIdentifier("composer-model")
                    ComposerOptions(task: task, project: project, chat: chat)
                    VoiceControl(task: task, chat: chat, onBegin: beginVoiceInput)
                    Button {
                        if showsStop { Task { await model.stop(task) } }
                        else { submitDraft() }
                    } label: {
                        Group {
                            if chat.sending || chat.stopping { ActivityDiamond() }
                            else { Image(systemName: showsStop ? "stop.fill" : "arrow.up").font(.system(size: showsStop ? 14 : ComposerMetrics.iconSize, weight: .semibold))
                                    .contentTransition(motion.effectsEnabled ? .symbolEffect(.replace) : .identity)
                                    .animation(motion.interactionAnimation, value: showsStop) }
                        }.frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize).contentShape(.rect)
                    }
                    .buttonStyle(ComposerControlStyle(role: showsStop ? .stop : .send))
                    .disabled(primaryDisabled)
                    .accessibilityLabel(showsStop ? "Stop task" : task.running ? "Queue message" : "Send message")
                    .accessibilityIdentifier(showsStop ? "stop-task" : "send-message")
                }.foregroundStyle(FD.secondary)
            }
        }
        .padding(.horizontal, 8).padding(.top, 12).padding(.bottom, 8).glassEffect(.regular.tint(FD.surface), in: .rect(cornerRadius: 26))
        .sensoryFeedback(.success, trigger: transcriptFeedback) { _, _ in motion.active }
        .sheet(isPresented: $showModels) {
            ComposerModelSheet(task: task, chat: chat, models: models) { showModels = false }
                .task(id: modelLoadScope) { await model.loadModels(task) }
        }
        .task(id: modelLoadScope) {
            async let catalog: Void = model.loadCatalog(task)
            await model.loadModels(task)
            await catalog
        }
        .sheet(isPresented: $showGoal) { GoalView(taskID: task.id, initialObjective: goalSeed) { if chat.draft == goalCommand { chat.draft = "" } } }
    }

    private func beginVoiceInput() {
        // TextSelection indices can outlive a send or draft edit. Keep their
        // owning text, and validate them once when dictation begins.
        chat.voiceInsertion = voiceSelection.map { VoiceDraftInsertion.capture($0.indices, in: $0.text) } ?? VoiceDraftInsertion(original: chat.draft, selection: nil)
        focused = false
    }
    private func receiveTranscript(_ text: String, submit: Bool) {
        Task { await acceptTranscript(text, submit: submit) }
    }
    private func acceptTranscript(_ text: String, submit: Bool) async {
        guard let caret = await model.finishVoiceInput(text, ownerID: task.id, chat: chat) else { return }
        transcriptFeedback &+= 1
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
