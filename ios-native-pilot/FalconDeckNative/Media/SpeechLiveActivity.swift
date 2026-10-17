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
    func speechAction(_ action: NativeSpeechCommand) async {
        switch action {
        case .cancel: voice.discard()
        case .toggle: if readAloud.messageID != nil { readAloud.togglePause() } else { SpeechLiveActivity.shared.readAloud(nil) }
        case .stop: readAloud.stop()
        case .finish:
            guard voice.recording else { SpeechLiveActivity.shared.voice(nil); return }
            voice.finishRecording()
            let current = connectionID, owner = voice.ownerID
            do {
                let text = try await voice.transcribe(model: self)
                guard current == connectionID, owner == voice.ownerID, let owner, let chat = chats[owner] else { return }
                chat.draft = chat.draft.isEmpty ? text : chat.draft + "\n" + text
                voice.discard()
            } catch { /* The recording remains available in Speech settings. */ }
        }
    }
}
