import SwiftUI

/// Approve / Request changes / Reject. Tapping the chosen one again takes it back.
struct ReviewDecisionChips: View {
    @Environment(\.dynamicTypeSize) private var textSize
    let selected: ReviewDecision?
    let identifier: String
    let choose: (ReviewDecision) -> Void

    var body: some View {
        let layout = textSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
        layout {
            ForEach(ReviewDecision.allCases, id: \.self) { decision in
                let chosen = selected == decision
                Button { choose(decision) } label: {
                    let content = Group {
                        Image(systemName: chosen ? "checkmark" : decision.symbol).font(.footnote.weight(.bold)).accessibilityHidden(true)
                        Text(decision.title).font(.footnote.weight(.semibold)).lineLimit(2).multilineTextAlignment(.center).minimumScaleFactor(0.85)
                    }
                    Group {
                        if textSize.isAccessibilitySize { HStack(spacing: 8) { content } } else { VStack(spacing: 4) { content } }
                    }
                    .frame(maxWidth: .infinity, minHeight: 56).padding(.horizontal, 4)
                    .foregroundStyle(chosen ? decision.tint : FD.body)
                    .background(chosen ? decision.tint.opacity(0.15) : FD.raised, in: .rect(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(chosen ? decision.tint : FD.hairline, lineWidth: chosen ? 1.5 : 1))
                    .contentShape(.rect(cornerRadius: 12))
                }
                .buttonStyle(.plain).sensoryFeedback(.selection, trigger: chosen)
                .accessibilityLabel(decision.title).accessibilityAddTraits(chosen ? .isSelected : [])
                .accessibilityIdentifier("\(identifier)-\(decision.rawValue)")
            }
        }
    }
}

/// Feedback that can be typed or dictated. Dictation uses the app's one voice
/// recorder, so its permissions, providers, saved-clip recovery and waveform are
/// the composer's own. The text lands in the field only after it is safely kept.
struct ReviewFeedbackField: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var textSize
    @AppStorage("native.speech.provider") private var provider = NativeSpeechSettings.defaultProvider
    let text: Binding<String>
    let prompt: String
    /// Names the recording, so a saved clip returns to the field it was made for.
    let dictationKey: String
    let identifier: String
    var focus: FocusState<String?>.Binding
    /// Called after a transcript is appended, so it can be written to disk first.
    let persist: () async -> Bool
    var dictateLabel = "Dictate feedback"
    @State private var showSavedRecording = false
    private var recorder: VoiceRecorder { model.voice }
    private var mine: Bool { recorder.ownerID == dictationKey }
    private var active: Bool { mine && (recorder.starting || recorder.recording || recorder.transcribing || recorder.acceptingTranscript || recorder.pendingURL != nil || recorder.error != nil) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 4) {
                TextField(prompt, text: text, axis: .vertical).lineLimit(2...8).font(.subheadline).foregroundStyle(FD.foreground)
                    .focused(focus, equals: identifier).padding(.vertical, 12).padding(.leading, 12)
                    .accessibilityIdentifier(identifier)
                if !active {
                    Button(action: mic) {
                        Image(systemName: "mic").font(.system(size: 17)).foregroundStyle(FD.secondary).frame(width: 44, height: 44).contentShape(.rect)
                    }
                    .buttonStyle(.plain).disabled(recorder.starting || recorder.acceptingTranscript || recorder.transcribing || recorder.recording)
                    .accessibilityLabel(dictateLabel).accessibilityIdentifier("\(identifier)-dictate")
                }
            }
            .background(FD.raised, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(focus.wrappedValue == identifier ? FD.accent.opacity(0.7) : FD.hairline))
            if active { panel }
        }
        .confirmationDialog("Saved recording", isPresented: $showSavedRecording, titleVisibility: .visible) {
            Button("Use recording here") { if recorder.recover(ownerID: dictationKey) { focus.wrappedValue = nil } }
            Button("Delete recording", role: .destructive) { model.discardVoiceInput() }
            Button("Cancel", role: .cancel) { }
        } message: { Text("This recording was made for something else. Use it here, or delete it and continue typing.") }
    }

    private func mic() {
        if recorder.pendingURL != nil, !mine { showSavedRecording = true; return }
        focus.wrappedValue = nil
        if recorder.pendingURL == nil {
            model.readAloud.stop(); model.realtimeAudio.stop()
            let current = model.sessionScope
            let selected = provider == "on-device" ? "on-device" : NativeSpeechSettings.defaultProvider
            Task { await recorder.start(ownerID: dictationKey, provider: selected, isCurrent: { current == model.sessionScope }) }
        }
    }

    private var processing: Bool { recorder.transcribing || recorder.acceptingTranscript }
    @ViewBuilder private var panel: some View {
        Group {
            if processing || recorder.starting || recorder.recording {
                HStack(spacing: 8) {
                    control("Cancel dictation", "xmark") { model.discardVoiceInput() }.disabled(recorder.acceptingTranscript)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            NativeActivityText(text: status, active: processing).foregroundStyle(recorder.recording ? FD.accent : FD.secondary)
                                .lineLimit(textSize.isAccessibilitySize ? 2 : 1).accessibilityIdentifier("review-dictation-status")
                            Spacer(minLength: 0)
                            if !recorder.starting, recorder.elapsed > 0 { Text(duration).monospacedDigit().foregroundStyle(FD.muted) }
                        }.font(.footnote.weight(.medium))
                        if recorder.recording { VoiceWaveform(recorder: recorder).frame(height: 28) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    if processing { ActivityDiamond() }
                    else { control("Stop and transcribe", "stop.fill", prominent: true) { transcribe() }.disabled(recorder.starting).accessibilityIdentifier("review-dictation-stop") }
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text(recorder.error == nil ? "Recording saved" : recorder.pendingURL == nil ? "Voice input unavailable" : "Couldn't transcribe")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(FD.foreground)
                    if let error = recorder.error { Text(error).font(.caption).foregroundStyle(FD.secondary).fixedSize(horizontal: false, vertical: true) }
                    HStack(spacing: 12) {
                        Button(role: .destructive) { model.discardVoiceInput() } label: {
                            Label(recorder.pendingURL == nil ? "Continue typing" : "Delete", systemImage: recorder.pendingURL == nil ? "xmark" : "trash").font(.subheadline).frame(minHeight: 32)
                        }.buttonStyle(.bordered)
                        Spacer(minLength: 0)
                        if recorder.pendingURL != nil {
                            Button { transcribe() } label: {
                                Label(recorder.error == nil ? "Transcribe" : "Retry", systemImage: recorder.error == nil ? "text.bubble" : "arrow.clockwise")
                                    .font(.subheadline.weight(.semibold)).frame(minHeight: 32)
                            }.buttonStyle(.borderedProminent).tint(FD.accent).foregroundStyle(FD.background)
                        }
                    }
                }
            }
        }.padding(.horizontal, 4).frame(minHeight: 48).accessibilityIdentifier("review-dictation")
    }
    private var status: String {
        processing ? (recorder.transcriptionAttempt > 1 ? "Retrying (\(recorder.transcriptionAttempt))" : "Transcribing…") : recorder.starting ? "Starting microphone…" : "Recording"
    }
    private var duration: String { let seconds = max(0, Int(recorder.elapsed)); return String(format: "%d:%02d", seconds / 60, seconds % 60) }
    private func control(_ label: String, _ symbol: String, prominent: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: symbol == "stop.fill" ? 14 : ComposerMetrics.iconSize, weight: .medium))
                .frame(width: ComposerMetrics.controlSize, height: ComposerMetrics.controlSize).contentShape(.rect)
        }.buttonStyle(ComposerControlStyle(role: prominent ? .send : .secondary, inset: 0)).accessibilityLabel(label)
    }

    private func transcribe() {
        guard let recording = recorder.pendingURL else { return }
        let current = model.sessionScope
        Task {
            do {
                let transcript = try await recorder.transcribe(model: model)
                guard current == model.sessionScope, recorder.pendingURL == recording, recorder.ownerID == dictationKey else { return }
                // Hold the panel in its busy state until the words are on disk.
                recorder.acceptingTranscript = true
                defer { recorder.acceptingTranscript = false }
                let before = text.wrappedValue
                text.wrappedValue = ReviewDictation.append(transcript, to: before)
                if await persist() { recorder.discard() }
                else {
                    text.wrappedValue = before
                    recorder.error = "Couldn't save the transcript. Your recording is safe; retry when ready."
                }
            } catch { /* The clip stays in the panel with Retry and Delete. */ }
        }
    }
}

enum ReviewDictation {
    /// A transcript goes after what is already typed, on its own space or line.
    static func append(_ transcript: String, to existing: String) -> String {
        let words = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return existing }
        if existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return words }
        let separator = existing.hasSuffix("\n") || existing.hasSuffix(" ") ? "" : " "
        return existing + separator + words
    }
}
