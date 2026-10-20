import AVFoundation
import Foundation
import Observation

/// Playback is owned by the native client. Speech synthesis still uses the daemon's
/// configured provider, so local and paired computers use the same credentials and voice.
@MainActor @Observable final class NativeAudioPlayback: NSObject, AVAudioPlayerDelegate {
    static let shared = NativeAudioPlayback()

    private(set) var isPlaying = false
    private(set) var isPreparing = false
    private(set) var currentlyPlayingID: String?
    private(set) var error: String?
    private(set) var errorMessageID: String?
    private(set) var isRealtimePlaying = false

    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var preparationTask: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private weak var playbackStore: AppStore?
    @ObservationIgnored private var pendingChunks: [String] = []
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var realtimeNode: AVAudioPlayerNode?
    @ObservationIgnored private var realtimeFormat: AVAudioFormat?
    @ObservationIgnored private var realtimeGeneration = UUID()
    @ObservationIgnored private var realtimeQueuedBytes = 0
    @ObservationIgnored private var realtimeTaskID: String?
    @ObservationIgnored private var silencedTaskID: String?
    @ObservationIgnored private var realtimeEnding = false
    @ObservationIgnored private var realtimeLastActivity = Date()
    @ObservationIgnored private var realtimeCleanup: Task<Void, Never>?

    /// Calling this again for the same message also stops a request that is still preparing.
    func speak(messageID: String, text: String, store: AppStore) {
        if currentlyPlayingID == messageID { stop(); return }
        stop()
        stopRealtime()
        error = nil
        errorMessageID = nil
        let spoken = Self.spokenText(text)
        pendingChunks = Self.chunks(spoken)
        guard !pendingChunks.isEmpty else {
            error = "There is no text to read aloud."
            errorMessageID = messageID
            return
        }
        currentlyPlayingID = messageID
        playbackStore = store
        playNextChunk()
    }

    func stop() {
        generation = UUID()
        preparationTask?.cancel()
        preparationTask = nil
        player?.delegate = nil
        player?.stop()
        player = nil
        currentlyPlayingID = nil
        playbackStore = nil
        pendingChunks.removeAll()
        isPlaying = false
        isPreparing = false
        error = nil
        errorMessageID = nil
    }

    private func playNextChunk() {
        guard let store = playbackStore, currentlyPlayingID != nil, !pendingChunks.isEmpty else { stop(); return }
        let text = pendingChunks.removeFirst()
        let current = generation
        isPreparing = true
        isPlaying = false
        preparationTask = Task { [weak self, weak store] in
            guard let store else { return }
            do {
                let response = try await store.request(
                    ["api", "speech", "synthesize"], method: "POST", body: .object(["text": .string(text)])
                )
                try Task.checkCancellation()
                guard let self, self.generation == current, self.currentlyPlayingID != nil else { return }
                let data = try Self.decodeSynthesizedAudio(response)
                let player = try AVAudioPlayer(data: data)
                player.delegate = self
                guard player.prepareToPlay() else { throw PilotError("Couldn't prepare the spoken response.") }
                self.player = player
                guard player.play() else { throw PilotError("Couldn't play the spoken response.") }
                self.isPreparing = false
                self.isPlaying = true
                self.preparationTask = nil
            } catch {
                guard let self, self.generation == current else { return }
                if error is CancellationError { self.stop() }
                else { self.failReadAloud(error) }
            }
        }
    }

    private func failReadAloud(_ failure: Error) {
        let messageID = currentlyPlayingID
        stop()
        error = failure.localizedDescription
        errorMessageID = messageID
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let identity = ObjectIdentifier(player)
        Task { @MainActor [weak self] in
            guard let self, self.player.map(ObjectIdentifier.init) == identity else { return }
            self.player?.delegate = nil
            self.player = nil
            guard flag else { self.failReadAloud(PilotError("Speech playback stopped unexpectedly.")); return }
            self.playNextChunk()
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let identity = ObjectIdentifier(player)
        let message = error?.localizedDescription ?? "Couldn't decode the spoken response."
        Task { @MainActor [weak self] in
            guard let self, self.player.map(ObjectIdentifier.init) == identity else { return }
            self.failReadAloud(PilotError(message))
        }
    }

    static func decodeSynthesizedAudio(_ response: JSON) throws -> Data {
        let mime = response["mime_type"].string.lowercased().split(separator: ";", maxSplits: 1).first
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
        let supported = Set([
            "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav",
            "audio/wave", "audio/x-wav", "audio/vnd.wave", "audio/aiff", "audio/x-aiff", "audio/flac", "audio/x-flac"
        ])
        guard supported.contains(mime) else { throw PilotError("The speech provider returned an unsupported audio format.") }
        let encoded = response["audio_base64"].string
        guard encoded.utf8.count <= 32_000_000,
              let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= 24_000_000 else {
            throw PilotError("The speech provider returned empty, invalid or oversized audio.")
        }
        return data
    }

    static func chunks(_ text: String, limit: Int = 4_000) -> [String] {
        guard limit > 0 else { return [] }
        let scalars = Array(text.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars)
        return stride(from: 0, to: scalars.count, by: limit).map { start in
            String(String.UnicodeScalarView(scalars[start..<min(start + limit, scalars.count)]))
        }
    }

    static func spokenText(_ text: String) -> String {
        text.replacingOccurrences(of: "(?s)```.*?```", with: "Code example.", options: .regularExpression)
            .replacingOccurrences(of: "!\\[[^\\]]*\\]\\([^)]*\\)", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "(?m)^#{1,6}\\s*|[*_`~]", with: "", options: .regularExpression)
    }

    /// Call only for live events belonging to the selected task, never transcript replay.
    func handleRealtime(_ event: JSON, taskID: String) {
        guard !taskID.isEmpty, currentlyPlayingID == nil else { return }
        switch event["type"].string {
        case "realtime-audio-started":
            stopRealtime()
            silencedTaskID = nil
            realtimeTaskID = taskID
            realtimeEnding = false
        case "realtime-audio-ended":
            if event["interrupted"].bool { stopRealtime() }
            else if realtimeTaskID == taskID {
                realtimeEnding = true
                if realtimeQueuedBytes == 0 { stopRealtime() }
            }
            if silencedTaskID == taskID { silencedTaskID = nil }
        case "realtime-audio-delta":
            guard silencedTaskID != taskID else { return }
            if let current = realtimeTaskID, current != taskID { stopRealtime() }
            realtimeTaskID = taskID
            guard !realtimeEnding else { return }
            let audio = event["audio"]
            do {
                let buffer = try Self.decodeRealtimePCM(
                    base64: audio["data"].string, sampleRate: audio["sample_rate"].int, channels: audio["num_channels"].int
                )
                if audio["samples_per_channel"] != .null,
                   audio["samples_per_channel"].optionalInt != Int(buffer.frameLength) {
                    throw PilotError("Incomplete realtime audio chunk.")
                }
                try append(buffer: buffer)
            } catch { failRealtime(error) }
        default: break
        }
    }

    /// Incoming audio is signed little-endian PCM16. The queue has a fixed memory ceiling.
    func append(base64: String, sampleRate: Int, channels: Int) {
        guard currentlyPlayingID == nil, !realtimeEnding else { return }
        do {
            let buffer = try Self.decodeRealtimePCM(base64: base64, sampleRate: sampleRate, channels: channels)
            try append(buffer: buffer)
        } catch { failRealtime(error) }
    }

    private func append(buffer: AVAudioPCMBuffer) throws {
        let bytes = Int(buffer.frameLength) * Int(buffer.format.channelCount) * MemoryLayout<Float>.size
        guard realtimeQueuedBytes + bytes <= 32_000_000 else {
            throw PilotError("Realtime audio fell behind. Playback was stopped to recover.")
        }
        if let format = realtimeFormat {
            guard format.sampleRate == buffer.format.sampleRate, format.channelCount == buffer.format.channelCount else {
                throw PilotError("Realtime audio changed format midstream.")
            }
        }
        let engine: AVAudioEngine
        let node: AVAudioPlayerNode
        if let existingEngine = self.engine, let existingNode = realtimeNode {
            engine = existingEngine
            node = existingNode
        } else {
            engine = AVAudioEngine()
            node = AVAudioPlayerNode()
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: buffer.format)
            self.engine = engine
            realtimeNode = node
            realtimeFormat = buffer.format
        }
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
        realtimeQueuedBytes += bytes
        realtimeLastActivity = Date()
        isRealtimePlaying = true
        let current = realtimeGeneration
        node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { @Sendable [weak self] _ in
            Task { @MainActor in
                guard let self, self.realtimeGeneration == current else { return }
                self.realtimeQueuedBytes = max(0, self.realtimeQueuedBytes - bytes)
                if self.realtimeQueuedBytes == 0, self.realtimeEnding { self.stopRealtime() }
            }
        }
        if !node.isPlaying { node.play() }
        startRealtimeCleanup()
    }

    func stopRealtime() {
        if let realtimeTaskID { silencedTaskID = realtimeTaskID }
        realtimeTaskID = nil
        realtimeGeneration = UUID()
        realtimeCleanup?.cancel()
        realtimeCleanup = nil
        realtimeNode?.stop()
        engine?.stop()
        if let realtimeNode { engine?.detach(realtimeNode) }
        engine = nil
        realtimeNode = nil
        realtimeFormat = nil
        realtimeQueuedBytes = 0
        realtimeEnding = false
        isRealtimePlaying = false
    }

    private func failRealtime(_ failure: Error) {
        stopRealtime()
        error = failure.localizedDescription
        errorMessageID = nil
    }

    private func startRealtimeCleanup() {
        guard realtimeCleanup == nil else { return }
        let current = realtimeGeneration
        realtimeCleanup = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
                guard let self, self.realtimeGeneration == current else { return }
                if Date().timeIntervalSince(self.realtimeLastActivity) >= 120 {
                    self.stopRealtime()
                    return
                }
            }
        }
    }

    static func decodeRealtimePCM(base64: String, sampleRate: Int, channels: Int) throws -> AVAudioPCMBuffer {
        guard (8_000...96_000).contains(sampleRate), (1...2).contains(channels), base64.utf8.count <= 2_800_000,
              let data = Data(base64Encoded: base64), !data.isEmpty, data.count <= 2_000_000,
              data.count % (channels * MemoryLayout<Int16>.size) == 0 else {
            throw PilotError("Unsupported realtime audio format.")
        }
        let frames = data.count / (channels * MemoryLayout<Int16>.size)
        guard let format = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate), channels: AVAudioChannelCount(channels)),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let output = buffer.floatChannelData else { throw PilotError("Couldn't allocate realtime audio.") }
        buffer.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { bytes in
            for frame in 0..<frames {
                for channel in 0..<channels {
                    let sample = Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: (frame * channels + channel) * 2, as: Int16.self))
                    output[channel][frame] = Float(sample) / 32768
                }
            }
        }
        return buffer
    }
}
