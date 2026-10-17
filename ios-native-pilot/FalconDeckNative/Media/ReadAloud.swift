import AVFoundation
import Foundation
import Observation
import MediaPlayer

@MainActor @Observable
final class ReadAloud: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    var messageID: String?
    var paused = false
    var loading = false
    var error: String?
    @ObservationIgnored private var synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var utteranceID: ObjectIdentifier?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private weak var playbackModel: AppModel?
    @ObservationIgnored private var pendingChunks: [String] = []
    @ObservationIgnored private var interruptions: AudioInterruptionObserver?
    override init() {
        super.init(); synthesizer.delegate = self
        interruptions = AudioInterruptionObserver { [weak self] in
            guard let self, self.messageID != nil, !self.paused else { return }
            self.togglePause()
        }
    }

    func play(_ text: String, id: String, model: AppModel) async {
        if messageID == id { stop(); return }
        stop(); messageID = id; loading = true; error = nil
        let current = generation, connection = model.connectionID
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
            let spoken = Self.spokenText(text)
            if !model.demo, UserDefaults.standard.string(forKey: "native.readAloud.provider") == "desktop" {
                let pieces = Self.chunks(spoken)
                guard let first = pieces.first else { throw PilotError("There is no text to read aloud.") }
                playbackModel = model; pendingChunks = Array(pieces.dropFirst())
                try await playChunk(first, model: model, generation: current, connection: connection)
            } else {
                let utterance = AVSpeechUtterance(string: spoken)
                utterance.voice = AVSpeechSynthesisVoice(language: UserDefaults.standard.string(forKey: "native.speech.language")?.nonempty ?? Locale.current.identifier)
                utteranceID = ObjectIdentifier(utterance); synthesizer.speak(utterance)
            }
            loading = false
            MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: "FalconDeck · Read aloud", MPNowPlayingInfoPropertyPlaybackRate: 1]
        } catch { if current == generation { stop(); self.error = error.localizedDescription } }
    }
    func togglePause() {
        guard messageID != nil else { return }
        if paused { try? AVAudioSession.sharedInstance().setActive(true); if let player { player.play() } else { synthesizer.continueSpeaking() } }
        else { if let player { player.pause() } else { synthesizer.pauseSpeaking(at: .word) } }
        paused.toggle()
        MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] = paused ? 0 : 1
    }
    func stop() {
        generation = UUID(); player?.stop(); player = nil; synthesizer.stopSpeaking(at: .immediate)
        utteranceID = nil; messageID = nil; paused = false; loading = false
        playbackModel = nil; pendingChunks = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in if self.utteranceID == id { self.stop() } }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let id = ObjectIdentifier(player)
        Task { @MainActor in
            guard self.player.map(ObjectIdentifier.init) == id else { return }
            guard flag else { self.stop(); self.error = "Speech playback stopped unexpectedly."; return }
            guard let model = self.playbackModel, !self.pendingChunks.isEmpty else { self.stop(); return }
            let text = self.pendingChunks.removeFirst(), current = self.generation
            self.loading = true
            do {
                try await self.playChunk(text, model: model, generation: current, connection: model.connectionID)
                if current == self.generation { self.loading = false }
            } catch { if current == self.generation { self.stop(); self.error = error.localizedDescription } }
        }
    }
    private func playChunk(_ text: String, model: AppModel, generation current: UUID, connection: UUID) async throws {
        let result = try await model.relay.call("speech.synthesize", params: .object(["text": .string(text)]))
        guard current == generation, connection == model.connectionID else { throw CancellationError() }
        guard let data = Data(base64Encoded: result["audio_base64"].string), !data.isEmpty else { throw PilotError("No speech audio was returned.") }
        let player = try AVAudioPlayer(data: data); player.delegate = self; self.player = player
        guard player.play() else { throw PilotError("Couldn't play the spoken response.") }
        if paused { player.pause() }
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
