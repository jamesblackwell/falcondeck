import SwiftUI

struct VoiceControl: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    @Bindable var chat: ChatSession
    var onBegin: () -> Void = {}
    @AppStorage("native.speech.provider") private var provider = NativeSpeechSettings.defaultProvider
    private var recorder: VoiceRecorder { model.voice }
    var body: some View {
        Button {
            onBegin()
            if recorder.pendingURL != nil, recorder.ownerID != task.id { model.showSpeechSettings = true; return }
            chat.voiceInputOpen = true
            if recorder.pendingURL == nil {
                model.readAloud.stop(); model.realtimeAudio.stop()
                let current = model.sessionScope
                let selectedProvider = provider == "on-device" ? "on-device" : NativeSpeechSettings.defaultProvider
                Task { await recorder.start(ownerID: task.id, provider: selectedProvider, isCurrent: { current == model.sessionScope }) }
            }
        } label: {
            Image(systemName: "mic").font(.system(size: ComposerMetrics.iconSize))
                .frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize).contentShape(.rect)
        }
            .buttonStyle(NativePressStyle())
            .accessibilityLabel(recorder.pendingURL == nil ? "Record voice message" : "Recover saved recording")
            .accessibilityIdentifier("record-voice")
            .disabled(chat.sending || chat.preparingAttachments || recorder.starting || recorder.recording || recorder.transcribing)
    }
}

/// Expo's in-composer flow: cancel, waveform/timer, stop-to-edit and send.
/// It replaces the normal input and footer instead of stacking another card.
struct RecordingPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var textSize
    let task: AgentTask
    @Bindable var chat: ChatSession
    var onTranscript: (String, Bool) -> Void
    private var recorder: VoiceRecorder { model.voice }
    var body: some View {
        Group {
            if let error = recorder.error, textSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    Text(error).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("voice-error")
                    HStack(spacing: 6) { cancelButton; Spacer(); failureActions }
                }
            } else { compactRow }
        }.frame(minHeight: 52).accessibilityIdentifier("voice-input")
    }
    private var compactRow: some View {
        HStack(spacing: 6) {
            cancelButton
            if let error = recorder.error {
                Text(error).font(.caption).foregroundStyle(.orange).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("voice-error")
                failureActions
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        NativeActivityText(text: status, active: recorder.transcribing).foregroundStyle(recorder.recording ? FD.accent : FD.secondary).lineLimit(textSize.isAccessibilitySize ? 2 : 1)
                            .accessibilityIdentifier("voice-status")
                        Spacer(minLength: 0)
                        if !recorder.starting { Text(duration).monospacedDigit().foregroundStyle(FD.muted) }
                    }.font(.footnote.weight(.medium))
                    if recorder.recording { VoiceWaveform(recorder: recorder).frame(height: 32) }
                }.frame(maxWidth: .infinity, alignment: .leading)
                if recorder.transcribing {
                    ActivityDiamond().frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize).accessibilityLabel(status)
                } else {
                    control("Stop and transcribe", symbol: "stop.fill") { transcribe(submit: false) }
                        .accessibilityHint("Puts the transcript in the composer to edit")
                        .disabled(recorder.starting)
                    control("Transcribe and send", symbol: "arrow.up", prominent: true) { transcribe(submit: true) }
                        .disabled(recorder.starting || chat.preparingAttachments || (!model.connected && !model.demo))
                }
            }
        }
    }
    private var cancelButton: some View { control("Cancel voice input", symbol: "xmark") { close() } }
    @ViewBuilder private var failureActions: some View {
        control("Speech settings", symbol: "gearshape") { close(); model.showSpeechSettings = true }
        if recorder.pendingURL != nil {
            control("Discard recording and record again", symbol: "trash") { recorder.discard(); recordAgain() }
        }
        control(recorder.pendingURL == nil ? "Try recording again" : "Retry transcription", symbol: "arrow.clockwise", prominent: true) {
            if recorder.pendingURL == nil { recordAgain() } else { transcribe(submit: false) }
        }
    }
    private var status: String {
        recorder.transcribing ? (recorder.transcriptionAttempt > 1 ? "Retrying (\(recorder.transcriptionAttempt))" : "Transcribing…") : recorder.starting ? "Starting microphone…" : recorder.recording ? "Recording" : "Recording ready"
    }
    private var duration: String { let seconds = max(0, Int(recorder.elapsed)); return String(format: "%d:%02d", seconds / 60, seconds % 60) }
    private func control(_ label: String, symbol: String, prominent: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: symbol == "stop.fill" ? 14 : ComposerMetrics.iconSize, weight: .medium))
                .frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize).background(prominent ? FD.accent : FD.raised, in: Circle())
                .foregroundStyle(prominent ? FD.background : FD.foreground)
                .contentShape(.rect)
        }.buttonStyle(NativePressStyle()).accessibilityLabel(label)
    }
    private func close() {
        recorder.finishRecording(); recorder.cancelTranscription(); chat.voiceInputOpen = false
    }
    private func recordAgain() {
        model.readAloud.stop(); model.realtimeAudio.stop()
        let current = model.sessionScope, provider = NativeSpeechSettings.provider(in: .standard)
        Task { await recorder.start(ownerID: task.id, provider: provider, isCurrent: { current == model.sessionScope }) }
    }
    private func transcribe(submit: Bool) {
        let current = model.sessionScope
        Task {
            do {
                let text = try await recorder.transcribe(model: model)
                guard current == model.sessionScope, recorder.ownerID == task.id, chat.voiceInputOpen else { return }
                onTranscript(text, submit)
            } catch { /* Failed audio remains available to retry, recover or discard. */ }
        }
    }
}
