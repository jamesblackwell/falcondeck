@preconcurrency import ActivityKit
import Foundation

@MainActor final class SpeechLiveActivity {
    static let shared = SpeechLiveActivity()
    private var voicePhase: String?
    private var readPhase: String?
    private var startedAt = Date.now
    private var pausedAt: Date?
    private var activity: Activity<NativeSpeechAttributes>?
    private var work: Task<Void, Never>?
    private var revision = UUID()
    private init() { }
    func voice(_ phase: String?) {
        if phase == "listening", voicePhase != phase { startedAt = .now }
        voicePhase = phase; schedule()
    }
    func readAloud(_ phase: String?) {
        if readPhase == nil, phase != nil { startedAt = .now }
        if readPhase == "paused", phase == "playing", let pausedAt { startedAt = startedAt.addingTimeInterval(Date.now.timeIntervalSince(pausedAt)) }
        if phase == "paused", readPhase != "paused" { pausedAt = .now }
        else if phase != "paused" { pausedAt = nil }
        readPhase = phase; schedule()
    }
    private func schedule() {
        let phase = voicePhase ?? readPhase, previous = work, current = UUID()
        revision = current
        work = Task {
            await previous?.value
            guard current == self.revision else { return }
            guard let phase else {
                let active = self.activity; self.activity = nil
                if let active { await active.end(nil, dismissalPolicy: .immediate) }
                // Clean up activities left behind by a terminated process.
                for orphan in Activity<NativeSpeechAttributes>.activities where orphan.id != active?.id { await orphan.end(nil, dismissalPolicy: .immediate) }
                return
            }
            guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
            let state = NativeSpeechAttributes.ContentState(phase: phase, startedAt: self.startedAt, pausedAt: self.pausedAt)
            let content = ActivityContent(state: state, staleDate: .now.addingTimeInterval(phase == "listening" ? 190 : 3600))
            if let activity = self.activity { await activity.update(content) }
            else { self.activity = try? Activity.request(attributes: NativeSpeechAttributes(startedAt: self.startedAt), content: content, pushType: nil) }
        }
    }
}

@MainActor extension AppModel {
    /// Only a registered draft may consume a saved recording. A transcription
    /// can finish after its task was archived or its chat instance replaced.
    @discardableResult func finishVoiceInput(_ text: String, ownerID: String, chat: ChatSession) async -> String.Index? {
        guard chats[ownerID] === chat, voice.ownerID == ownerID, !voice.acceptingTranscript else { return nil }
        let current = sessionScope, recording = voice.pendingURL
        let original = chat.draft, insertion = chat.voiceInsertion, wasOpen = chat.voiceInputOpen
        let lease = backgroundExecution.begin("Save transcribed input")
        voice.acceptingTranscript = true
        defer { voice.acceptingTranscript = false; lease.finish() }
        let caret = chat.insertVoiceTranscript(text)
        let inserted = chat.draft
        draftSaves.removeValue(forKey: ownerID)?.cancel()
        do {
            if !demo {
                guard let store = draftStore else { throw PilotError("Input storage is not ready. Your recording has been kept.") }
                try await store.save(chat.saved(id: ownerID))
            }
        } catch {
            guard current == sessionScope, chats[ownerID] === chat else { return nil }
            if chat.draft.utf16.elementsEqual(inserted.utf16) { chat.draft = original; chat.voiceInsertion = insertion; chat.voiceInputOpen = wasOpen }
            voice.error = "Couldn't save the transcript. Your recording is safe; retry when ready."
            return nil
        }
        guard current == sessionScope, chats[ownerID] === chat, voice.ownerID == ownerID, voice.pendingURL == recording else { return nil }
        voice.discard()
        return chat.draft.utf16.elementsEqual(inserted.utf16) ? caret : chat.draft.endIndex
    }

    func speechAction(_ action: NativeSpeechCommand) async {
        switch action {
        case .cancel: voice.discard()
        case .toggle: if readAloud.messageID != nil { readAloud.togglePause() } else { SpeechLiveActivity.shared.readAloud(nil) }
        case .stop: readAloud.stop()
        case .finish:
            guard voice.recording else { SpeechLiveActivity.shared.voice(nil); return }
            let lease = backgroundExecution.begin("Finish voice input")
            defer { lease.finish() }
            voice.finishRecording()
            let current = sessionScope, owner = voice.ownerID
            do {
                let text = try await voice.transcribe(model: self)
                guard current == sessionScope, owner == voice.ownerID, let owner, let chat = chats[owner] else { return }
                _ = await finishVoiceInput(text, ownerID: owner, chat: chat)
            } catch { /* The recording remains available in Speech settings. */ }
        }
    }
}
