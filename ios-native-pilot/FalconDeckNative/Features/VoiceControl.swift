import SwiftUI

struct VoiceControl: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    @Bindable var chat: ChatSession
    @AppStorage("native.speech.provider") private var provider = "on-device"
    private var recorder: VoiceRecorder { model.voice }
    var body: some View {
        Button {
            if recorder.pendingURL != nil { model.showSpeechSettings = true }
            else {
                model.readAloud.stop()
                let current = model.connectionID
                Task { await recorder.start(ownerID: task.id, provider: provider, isCurrent: { current == model.connectionID }) }
            }
        } label: { Image(systemName: "mic").frame(width: 28, height: 28) }
            .accessibilityLabel(recorder.pendingURL == nil ? "Record voice message" : "Recover saved recording")
            .disabled(chat.sending || recorder.starting || recorder.recording || recorder.transcribing)

    }
}

struct RecordingPanel: View {
    @Environment(AppModel.self) private var model
    let task: AgentTask
    @Bindable var chat: ChatSession
    private var recorder: VoiceRecorder { model.voice }
    var body: some View {
        if recorder.ownerID == task.id, recorder.pendingURL != nil {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    if recorder.transcribing { ActivityDiamond() }
                    else { Image(systemName: recorder.recording ? "waveform" : "mic").foregroundStyle(recorder.recording ? .red : FD.accent) }
                    Text(recorder.recording ? "Listening · \(Int(recorder.elapsed))s" : recorder.transcribing ? "Transcribing…" : "Recording ready").font(.footnote)
                    Spacer()
                    Button(recorder.recording ? "Finish" : "Transcribe") { Task { await transcribe() } }.disabled(recorder.transcribing)
                    Button("Discard", role: .destructive) { recorder.discard() }.disabled(recorder.transcribing)
                }
                if recorder.recording { ProgressView(value: Double(recorder.level)).tint(FD.accent) }
                if let error = recorder.error { Text(error).font(.footnote).foregroundStyle(.orange) }
            }.padding(12).background(FD.surface, in: .rect(cornerRadius: 14))
        } else if let error = recorder.error, recorder.ownerID == nil {
            Text(error).font(.footnote).foregroundStyle(.orange)
        }
    }
    private func transcribe() async {
        let current = model.connectionID
        do {
            let text = try await recorder.transcribe(model: model)
            guard current == model.connectionID else { return }
            chat.draft = chat.draft.isEmpty ? text : chat.draft + "\n" + text
            recorder.discard()
        } catch { /* The retained recording and error remain available for retry. */ }
    }
}
