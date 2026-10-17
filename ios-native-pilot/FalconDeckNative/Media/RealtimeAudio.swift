import AVFoundation
import Foundation
import Observation

enum RealtimePCM {
    static func decode(_ chunk: JSON) throws -> AVAudioPCMBuffer {
        guard let rate = chunk["sample_rate"].optionalInt, (8000...96000).contains(rate), let channels = chunk["num_channels"].optionalInt, (1...2).contains(channels), chunk["data"].string.utf8.count <= 2_800_000,
              let data = Data(base64Encoded: chunk["data"].string), !data.isEmpty, data.count <= 2_000_000, data.count % (channels * 2) == 0 else { throw PilotError("Unsupported realtime audio format.") }
        let frames = data.count / (channels * 2)
        if chunk["samples_per_channel"] != .null, chunk["samples_per_channel"].optionalInt != frames { throw PilotError("Incomplete realtime audio chunk.") }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: Double(rate), channels: AVAudioChannelCount(channels)), let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)), let output = buffer.floatChannelData else { throw PilotError("Couldn't allocate realtime audio.") }
        buffer.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { bytes in
            for frame in 0..<frames { for channel in 0..<channels {
                let sample = Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: (frame * channels + channel) * 2, as: Int16.self))
                output[channel][frame] = Float(sample) / 32768
            } }
        }
        return buffer
    }
}

@MainActor @Observable final class RealtimeAudio {
    var active: Set<String> = []
    var error: String?
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var playback: [String: Playback] = [:]
    @ObservationIgnored private var silenced: Set<String> = []
    @ObservationIgnored private var cleanup: Task<Void, Never>?
    @ObservationIgnored private var interruptions: AudioInterruptionObserver?
    private final class Playback {
        let id = UUID()
        var node: AVAudioPlayerNode?
        var format: AVAudioFormat?
        var bytes = 0
        var ending = false
        var lastActivity = Date.now
    }
    init() { interruptions = AudioInterruptionObserver { [weak self] in self?.stop() } }
    func handle(_ event: JSON, taskID: String) {
        guard !taskID.isEmpty else { return }
        let type = event["type"].string
        if type == "realtime-audio-started" { stop(taskID); silenced.remove(taskID); install(taskID); return }
        if type == "realtime-audio-ended" {
            if event["interrupted"].bool { stop(taskID) }
            else if let state = playback[taskID] { state.ending = true; state.lastActivity = .now; if state.bytes == 0 { stop(taskID) } }
            silenced.remove(taskID); return
        }
        guard type == "realtime-audio-delta", !silenced.contains(taskID) else { return }
        do {
            let buffer = try RealtimePCM.decode(event["audio"])
            if playback[taskID] == nil { install(taskID) }
            guard let state = playback[taskID], !state.ending else { return }
            state.lastActivity = .now
            let bytes = Int(buffer.frameLength) * Int(buffer.format.channelCount) * 4
            guard playback.values.reduce(bytes, { $0 + $1.bytes }) <= 32_000_000 else { throw PilotError("Realtime audio fell behind. Playback was stopped to recover.") }
            let engine = try audioEngine()
            if let format = state.format {
                guard format.sampleRate == buffer.format.sampleRate, format.channelCount == buffer.format.channelCount else { throw PilotError("Realtime audio changed format midstream.") }
            }
            let node: AVAudioPlayerNode
            if let existing = state.node { node = existing }
            else {
                node = AVAudioPlayerNode(); state.node = node; state.format = buffer.format
                engine.attach(node); engine.connect(node, to: engine.mainMixerNode, format: buffer.format)
            }
            if !engine.isRunning { engine.prepare(); try engine.start() }
            state.bytes += bytes
            let id = state.id
            node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { @Sendable [weak self] _ in
                Task { @MainActor in
                    guard let self, let current = self.playback[taskID], current.id == id else { return }
                    current.bytes = max(0, current.bytes - bytes)
                    if current.bytes == 0, current.ending { self.stop(taskID) }
                }
            }
            if !node.isPlaying { node.play() }
        } catch { self.error = error.localizedDescription; stop(taskID) }
    }
    func stop(_ taskID: String? = nil) {
        for id in taskID.map({ [$0] }) ?? Array(playback.keys) {
            silenced.insert(id)
            if let state = playback.removeValue(forKey: id), let node = state.node { node.stop(); engine?.detach(node) }
            active.remove(id)
        }
        if playback.isEmpty {
            let ownedAudio = engine != nil
            cleanup?.cancel(); cleanup = nil; engine?.stop(); engine = nil
            if ownedAudio { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        }
    }
    func reset() { stop(); silenced = []; error = nil }
    private func install(_ id: String) {
        if playback.count >= 8, let oldest = playback.min(by: { $0.value.lastActivity < $1.value.lastActivity })?.key { stop(oldest) }
        playback[id] = Playback(); active.insert(id)
        if cleanup == nil {
            cleanup = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(15)) } catch { return }
                    guard let self else { return }
                    for id in self.playback.filter({ Date.now.timeIntervalSince($0.value.lastActivity) > 120 }).keys { self.stop(id) }
                }
            }
        }
    }
    private func audioEngine() throws -> AVAudioEngine {
        if let engine { return engine }
        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try AVAudioSession.sharedInstance().setActive(true)
        let engine = AVAudioEngine(); self.engine = engine
        return engine
    }
}
