import AVFoundation
import Foundation
import Observation
import MediaPlayer

@MainActor protocol ReadAloudPlayback: AnyObject {
    @discardableResult func play() -> Bool
    func pause()
    func stop()
}
extension AVAudioPlayer: ReadAloudPlayback { }

@MainActor @Observable
final class ReadAloud: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    var messageID: String?
    var paused = false
    var loading = false
    var error: String?
    var errorMessageID: String?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let makePlayer: (Data) throws -> any ReadAloudPlayback
    @ObservationIgnored private var synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var player: (any ReadAloudPlayback)?
    @ObservationIgnored private var utteranceID: ObjectIdentifier?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var ownsAudioSession = false
    @ObservationIgnored private weak var playbackModel: AppModel?
    @ObservationIgnored private var pendingChunks: [String] = []
    @ObservationIgnored private var interruptions: AudioInterruptionObserver?
    @ObservationIgnored private var remoteControls: RemotePlaybackControls?
    override convenience init() { self.init(defaults: .standard) }
    init(defaults: UserDefaults, makePlayer: @escaping (Data) throws -> any ReadAloudPlayback = { try AVAudioPlayer(data: $0) }) {
        self.defaults = defaults; self.makePlayer = makePlayer
        super.init(); synthesizer.delegate = self
        interruptions = AudioInterruptionObserver { [weak self] in
            guard let self, self.messageID != nil, !self.paused else { return }
            self.togglePause()
        }
    }

    func play(_ text: String, id: String, model: AppModel) async {
        if messageID == id { stop(); return }
        guard !model.voice.starting, !model.voice.recording, !model.voice.transcribing else {
            error = "Finish voice input before starting read aloud."; errorMessageID = id
            return
        }
        stop(); model.realtimeAudio.stop(); messageID = id; loading = true; error = nil; errorMessageID = nil
        remoteControls = RemotePlaybackControls { [weak self] action in
            guard let self, self.messageID != nil else { return }
            switch action {
            case .play: if self.paused { self.togglePause() }
            case .pause: if !self.paused { self.togglePause() }
            case .toggle: self.togglePause()
            case .stop: self.stop()
            }
        }
        SpeechLiveActivity.shared.readAloud("preparing")
        let current = generation, session = model.sessionScope
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
            ownsAudioSession = true
            let spoken = Self.spokenText(text)
            guard !spoken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PilotError("There is no text to read aloud.") }
            if !model.demo, defaults.string(forKey: "native.readAloud.provider") == "desktop" {
                let pieces = Self.chunks(spoken)
                guard let first = pieces.first else { throw PilotError("There is no text to read aloud.") }
                playbackModel = model; pendingChunks = Array(pieces.dropFirst())
                try await playChunk(first, model: model, generation: current, session: session)
            } else {
                let utterance = AVSpeechUtterance(string: spoken)
                utterance.voice = AVSpeechSynthesisVoice(language: defaults.string(forKey: "native.speech.language")?.nonempty ?? Locale.current.identifier)
                utteranceID = ObjectIdentifier(utterance); synthesizer.speak(utterance)
            }
            guard current == generation, session == model.sessionScope else { return }
            loading = false
            SpeechLiveActivity.shared.readAloud(paused ? "paused" : "playing")
            MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: "FalconDeck · Read aloud", MPNowPlayingInfoPropertyPlaybackRate: paused ? 0 : 1]
        } catch { if current == generation { fail(error, messageID: id) } }
    }
    func togglePause() {
        guard messageID != nil else { return }
        // While fetching a chunk, remember intent without restarting the
        // previous AVAudioPlayer (which has already reached its end).
        if !loading {
            if paused {
                do { try AVAudioSession.sharedInstance().setActive(true) }
                catch { fail(error); return }
                if let player {
                    guard player.play() else { fail(PilotError("Couldn't resume the spoken response.")); return }
                } else { synthesizer.continueSpeaking() }
            } else {
                if let player { player.pause() } else { synthesizer.pauseSpeaking(at: .word) }
            }
        }
        paused.toggle()
        SpeechLiveActivity.shared.readAloud(paused ? "paused" : loading ? "preparing" : "playing")
        MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] = paused ? 0 : 1
    }
    func stop() {
        generation = UUID(); player?.stop(); player = nil; synthesizer.stopSpeaking(at: .immediate)
        utteranceID = nil; messageID = nil; paused = false; loading = false
        playbackModel = nil; pendingChunks = []
        remoteControls?.remove(); remoteControls = nil
        SpeechLiveActivity.shared.readAloud(nil)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        if ownsAudioSession {
            ownsAudioSession = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
    private func fail(_ error: Error, messageID: String? = nil) {
        let id = messageID ?? self.messageID
        stop(); self.error = error.localizedDescription; errorMessageID = id
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in if self.utteranceID == id { self.stop() } }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in
            if self.utteranceID == id { self.fail(PilotError("Speech was interrupted. Tap Read aloud to try again.")) }
        }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let id = ObjectIdentifier(player), message = error?.localizedDescription ?? "Couldn't decode the spoken response."
        Task { @MainActor in
            if self.player.map(ObjectIdentifier.init) == id { self.fail(PilotError(message)) }
        }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let id = ObjectIdentifier(player)
        Task { @MainActor in await self.playbackFinished(id: id, successfully: flag) }
    }
    func playbackFinished(id: ObjectIdentifier, successfully flag: Bool) async {
        guard self.player.map(ObjectIdentifier.init) == id else { return }
        self.player = nil
        guard flag else { self.fail(PilotError("Speech playback stopped unexpectedly.")); return }
        guard let model = self.playbackModel, !self.pendingChunks.isEmpty else { self.stop(); return }
        let text = self.pendingChunks.removeFirst(), current = self.generation
        self.loading = true
        do {
            try await self.playChunk(text, model: model, generation: current, session: model.sessionScope)
            if current == self.generation { self.loading = false }
        } catch { if current == self.generation { self.fail(error) } }
    }
    private func playChunk(_ text: String, model: AppModel, generation current: UUID, session: UUID) async throws {
        try await SpeechConnection.waitUntilReady(isReady: { model.connected }, isCurrent: { current == self.generation && session == model.sessionScope })
        let result = try await model.relay.call("speech.synthesize", params: .object(["text": .string(text)]))
        guard current == generation, session == model.sessionScope else { throw CancellationError() }
        guard let data = Data(base64Encoded: result["audio_base64"].string), !data.isEmpty else { throw PilotError("No speech audio was returned.") }
        let player = try makePlayer(data); (player as? AVAudioPlayer)?.delegate = self; self.player = player
        if !paused, !player.play() { throw PilotError("Couldn't play the spoken response.") }
    }
    static func chunks(_ text: String, limit: Int = 4000) -> [String] {
        guard limit > 0 else { return [] }
        let scalars = Array(text.unicodeScalars)
        return stride(from: 0, to: scalars.count, by: limit).map { start in String(String.UnicodeScalarView(scalars[start..<min(start + limit, scalars.count)])) }
    }
    static func spokenText(_ text: String) -> String {
        text.replacingOccurrences(of: "(?s)```.*?```", with: "Code example.", options: .regularExpression)
            .replacingOccurrences(of: "!\\[[^\\]]*\\]\\([^)]*\\)", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "(?m)^#{1,6}\\s*|[*_`~]", with: "", options: .regularExpression)
    }
}
