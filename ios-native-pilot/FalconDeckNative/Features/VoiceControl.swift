import SwiftUI

struct VoiceControl: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    @Bindable var chat: ChatSession
    var onBegin: () -> Void = {}
    @AppStorage("native.speech.provider") private var provider = NativeSpeechSettings.defaultProvider
    @State private var showSavedRecording = false
    @State private var savedRecording: URL?
    private var recorder: VoiceRecorder { model.voice }
    var body: some View {
        Button {
            if let url = recorder.pendingURL, recorder.ownerID != task.id {
                savedRecording = url; showSavedRecording = true
            } else { openVoiceInput() }
        } label: {
            Image(systemName: "mic").font(.system(size: ComposerMetrics.iconSize))
                .frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize).contentShape(.rect)
        }
        .buttonStyle(ComposerControlStyle())
        .accessibilityLabel(recorder.pendingURL == nil ? "Record voice message" : "Recover saved recording")
        .accessibilityIdentifier("record-voice")
        .disabled(chat.sending || chat.preparingAttachments || recorder.acceptingTranscript || recorder.starting)
        .confirmationDialog("Saved recording", isPresented: $showSavedRecording, titleVisibility: .visible) {
            Button("Use recording here") {
                guard recorder.pendingURL == savedRecording, model.recoverVoiceInput(in: task) else { return }
                onBegin()
            }
            Button("Delete recording", role: .destructive) {
                guard recorder.pendingURL == savedRecording else { return }
                model.discardVoiceInput()
            }
            Button("Cancel", role: .cancel) { }
        } message: { Text("This recording is from another task. Use it here, or delete it and continue typing.") }
    }
    private func openVoiceInput() {
        onBegin(); chat.voiceInputOpen = true
        if recorder.pendingURL == nil {
            model.readAloud.stop(); model.realtimeAudio.stop()
            let current = model.sessionScope
            let selectedProvider = provider == "on-device" ? "on-device" : NativeSpeechSettings.defaultProvider
            Task { await recorder.start(ownerID: task.id, provider: selectedProvider, isCurrent: { current == model.sessionScope }) }
        }
    }
}

/// Live capture stays compact. Saved/error states name the two distinct actions:
/// delete and continue typing, or transcribe the existing clip without resending.
struct RecordingPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.nativeMotion) private var motion
    @Environment(\.dynamicTypeSize) private var textSize
    let task: AgentTask
    @Bindable var chat: ChatSession
    var onClose: () -> Void = {}
    var onTranscript: (String, Bool, URL) -> Void
    private var recorder: VoiceRecorder { model.voice }
    private var processing: Bool { recorder.transcribing || recorder.acceptingTranscript }
    var body: some View {
        Group {
            if !processing && !recorder.starting && !recorder.recording { recoveryPanel }
            else { captureRow }
        }.frame(minHeight: 52).accessibilityIdentifier("voice-input")
            .sensoryFeedback(.error, trigger: recorder.error) { _, error in
                error != nil && motion.active && recorder.ownerID == task.id && chat.voiceInputOpen
            }
    }
    private var captureRow: some View {
        HStack(spacing: 6) {
            control(recorder.pendingURL == nil ? "Cancel voice input" : "Delete recording", symbol: recorder.pendingURL == nil ? "xmark" : "trash") { discard() }
                .disabled(recorder.acceptingTranscript)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    NativeActivityText(text: status, active: processing).foregroundStyle(recorder.recording ? FD.accent : FD.secondary).lineLimit(textSize.isAccessibilitySize ? 2 : 1)
                        .accessibilityIdentifier("voice-status")
                    Spacer(minLength: 0)
                    if !recorder.starting, recorder.elapsed > 0 { Text(duration).monospacedDigit().foregroundStyle(FD.muted) }
                }.font(.footnote.weight(.medium))
                if recorder.recording { VoiceWaveform(recorder: recorder).frame(height: 32) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if processing {
                ActivityDiamond().frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize).accessibilityLabel(status)
            } else {
                control("Stop and transcribe", symbol: "stop.fill") { transcribe(submit: false) }
                    .accessibilityHint("Puts the transcript in the composer to edit").disabled(recorder.starting)
                control("Transcribe and send", symbol: "arrow.up", prominent: true) { transcribe(submit: true) }
                    .disabled(recorder.starting || chat.preparingAttachments || (!model.connected && !model.demo))
            }
        }
    }
    private var recoveryPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(recorder.error == nil ? "Recording saved" : recorder.pendingURL == nil ? "Voice input unavailable" : "Couldn't transcribe")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(FD.foreground)
                    if let error = recorder.error {
                        Text(error).font(.caption).foregroundStyle(FD.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("voice-error")
                    } else {
                        Text(recorder.elapsed >= NativeSpeechSettings.maximumRecordingDuration
                            ? "30-minute limit reached. Your recording is saved and ready to transcribe."
                            : "Transcribe to review your message before sending.").font(.caption).foregroundStyle(FD.secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                Menu {
                    Button("Keep recording for later", systemImage: "tray.and.arrow.down") { keepForLater() }.disabled(recorder.pendingURL == nil)
                    Button("Speech settings", systemImage: "gearshape") { keepForLater(focus: false); model.showSpeechSettings = true }
                } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(.rect) }
                    .foregroundStyle(FD.secondary).accessibilityLabel("Recording options")
            }
            if textSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) { deleteButton; transcribeButton }
            } else { HStack(spacing: 12) { deleteButton; Spacer(minLength: 0); transcribeButton } }
        }.padding(.horizontal, 8)
    }
    private var deleteButton: some View {
        Button(role: .destructive) { discard() } label: {
            Label(recorder.pendingURL == nil ? "Continue typing" : "Delete recording", systemImage: recorder.pendingURL == nil ? "xmark" : "trash")
                .font(.subheadline).frame(minHeight: 32)
        }.buttonStyle(.bordered).disabled(recorder.acceptingTranscript)
    }
    private var transcribeButton: some View {
        Button {
            if recorder.pendingURL == nil { recordAgain() } else { transcribe(submit: false) }
        } label: {
            Label(recorder.error == nil ? "Transcribe" : "Retry", systemImage: recorder.error == nil ? "text.bubble" : "arrow.clockwise")
                .font(.subheadline.weight(.semibold)).frame(minHeight: 32)
        }.buttonStyle(.borderedProminent).tint(FD.accent).foregroundStyle(FD.background)
            .accessibilityLabel(recorder.pendingURL == nil ? "Try recording again" : recorder.error == nil ? "Transcribe recording" : "Retry transcription")
    }
    private var status: String {
        processing ? (recorder.transcriptionAttempt > 1 ? "Retrying (\(recorder.transcriptionAttempt))" : "Transcribing…") : recorder.starting ? "Starting microphone…" : "Recording"
    }
    private var duration: String { let seconds = max(0, Int(recorder.elapsed)); return String(format: "%d:%02d", seconds / 60, seconds % 60) }
    private func control(_ label: String, symbol: String, prominent: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: symbol == "stop.fill" ? 14 : ComposerMetrics.iconSize, weight: .medium))
                .frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize).contentShape(.rect)
        }.buttonStyle(ComposerControlStyle(role: prominent ? .send : .secondary, inset: 0)).accessibilityLabel(label)
    }
    private func discard() { if model.discardVoiceInput() { onClose() } }
    private func keepForLater(focus: Bool = true) {
        guard !recorder.acceptingTranscript else { return }
        recorder.finishRecording(); recorder.cancelTranscription(); chat.voiceInputOpen = false
        if focus { onClose() }
    }
    private func recordAgain() {
        model.readAloud.stop(); model.realtimeAudio.stop()
        let current = model.sessionScope, provider = NativeSpeechSettings.provider(in: .standard)
        Task { await recorder.start(ownerID: task.id, provider: provider, isCurrent: { current == model.sessionScope }) }
    }
    private func transcribe(submit: Bool) {
        guard let recording = recorder.pendingURL else { return }
        let current = model.sessionScope
        Task {
            do {
                let text = try await recorder.transcribe(model: model)
                guard current == model.sessionScope, recorder.pendingURL == recording, recorder.ownerID == task.id, chat.voiceInputOpen else { return }
                onTranscript(text, submit, recording)
            } catch { /* Keep the clip inline, with explicit retry and delete actions. */ }
        }
    }
}
