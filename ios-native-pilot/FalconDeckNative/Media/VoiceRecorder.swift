import AVFoundation
import Foundation
import Observation
import Speech

@MainActor @Observable
final class VoiceRecorder: NSObject, AVAudioRecorderDelegate {
    var recording = false
    var starting = false
    var transcribing = false
    var elapsed: TimeInterval = 0
    var level: Float = 0
    var error: String?
    private(set) var ownerID: String?
    private(set) var pendingURL: URL?
    private(set) var provider = "on-device"
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var meter: Task<Void, Never>?
    @ObservationIgnored private var recognition: SFSpeechRecognitionTask?
    @ObservationIgnored private var recognitionWaiter: CheckedContinuation<String, Error>?
    @ObservationIgnored private var recognitionTimeout: Task<Void, Never>?
    @ObservationIgnored private var recognitionID = UUID()
    @ObservationIgnored private var interruptions: AudioInterruptionObserver?

    @ObservationIgnored private let defaults: UserDefaults

    override convenience init() { self.init(defaults: .standard) }
    init(defaults: UserDefaults) {
        self.defaults = defaults
        super.init()
        interruptions = AudioInterruptionObserver { [weak self] in self?.interrupted() }
        if let path = defaults.string(forKey: "native.voice.pending"), FileManager.default.fileExists(atPath: path) {
            pendingURL = URL(fileURLWithPath: path)
            ownerID = defaults.string(forKey: "native.voice.owner")
            provider = defaults.string(forKey: "native.voice.provider") ?? "on-device"
        }
    }

    func start(ownerID: String, provider: String, isCurrent: () -> Bool = { true }) async {
        guard !starting, !recording, !transcribing, pendingURL == nil else { return }
        starting = true; defer { starting = false }
        error = nil
        guard await AVAudioApplication.requestRecordPermission() else { error = "Allow microphone access in Settings to record a message."; return }
        guard isCurrent(), !Task.isCancelled else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appending(path: "Voice", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var protectedDirectory = directory
            var resourceValues = URLResourceValues(); resourceValues.isExcludedFromBackup = true
            try protectedDirectory.setResourceValues(resourceValues)
            let url = directory.appending(path: "\(UUID()).m4a")
            let recorder = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000])
            recorder.delegate = self; recorder.isMeteringEnabled = true
            guard recorder.record() else { throw PilotError("Couldn't start the microphone.") }
            self.recorder = recorder; pendingURL = url; self.ownerID = ownerID; self.provider = provider
            defaults.set(url.path, forKey: "native.voice.pending")
            defaults.set(ownerID, forKey: "native.voice.owner")
            defaults.set(provider, forKey: "native.voice.provider")
            // Lock Screen Finish reopens the finalized file for transcription.
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
            recording = true; elapsed = 0
            SpeechLiveActivity.shared.voice("listening")
            meter = Task {
                while !Task.isCancelled, self.recording {
                    if self.recorder?.isRecording != true { self.interrupted(); return }
                    self.recorder?.updateMeters()
                    self.elapsed = self.recorder?.currentTime ?? self.elapsed
                    self.level = pow(10, (self.recorder?.averagePower(forChannel: 0) ?? -60) / 20)
                    if self.elapsed >= 180 { self.finishRecording(); return }
                    do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                }
            }
        } catch { self.error = error.localizedDescription; try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }

    func finishRecording() {
        recorder?.stop(); recorder = nil; meter?.cancel(); meter = nil; recording = false; level = 0
        SpeechLiveActivity.shared.voice(nil)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func discard() {
        finishRecording(); recognition?.cancel(); resolveRecognition(.failure(CancellationError()))
        if let pendingURL { try? FileManager.default.removeItem(at: pendingURL) }
        pendingURL = nil; ownerID = nil; error = nil
        defaults.removeObject(forKey: "native.voice.pending")
        defaults.removeObject(forKey: "native.voice.owner")
    }

    func cancelTranscription() {
        recognition?.cancel(); resolveRecognition(.failure(CancellationError()))
    }

    func interrupted() {
        guard recording else { return }
        finishRecording()
        error = "Recording was interrupted. Your captured audio is safe; transcribe or discard it when ready."
    }

    func transcribe(model: AppModel, using providerOverride: String? = nil) async throws -> String {
        guard !transcribing, let url = pendingURL else { throw PilotError("Record a message first.") }
        if let providerOverride { provider = providerOverride; defaults.set(providerOverride, forKey: "native.voice.provider") }
        finishRecording(); transcribing = true; error = nil
        SpeechLiveActivity.shared.voice("transcribing")
        defer { transcribing = false; SpeechLiveActivity.shared.voice(nil) }
        let current = model.connectionID
        let text: String
        do {
            if provider == "openrouter" {
                guard model.connected else { throw PilotError("Connect to your computer to transcribe. The recording stays on this device.") }
                let audio = try await Task.detached {
                    let data = try Data(contentsOf: url)
                    guard !data.isEmpty, data.count <= 8 * 1024 * 1024 else { throw PilotError("Record a shorter message (up to 8 MB).") }
                    return data.base64EncodedString()
                }.value
                guard current == model.connectionID else { throw CancellationError() }
                var params = JSON.object(["audio_base64": .string(audio), "format": .string("m4a"), "model": .string(defaults.string(forKey: "native.speech.model") ?? "openai/gpt-4o-mini-transcribe")])
                if let language = defaults.string(forKey: "native.speech.language")?.nonempty { params = params.setting("language", .string(language)) }
                text = try await model.relay.call("speech.transcribe", params: params)["text"].string
            } else {
                let authorization = await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { @Sendable status in continuation.resume(returning: status) } }
                guard current == model.connectionID, !Task.isCancelled else { throw CancellationError() }
                guard authorization == .authorized else { throw PilotError("Allow Speech Recognition in Settings to transcribe on this device.") }
                let locale = Locale(identifier: defaults.string(forKey: "native.speech.language")?.nonempty ?? Locale.current.identifier)
                guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
                    throw PilotError("On-device speech recognition is unavailable for this language. Choose another language or OpenRouter in Speech settings.")
                }
                let request = SFSpeechURLRecognitionRequest(url: url)
                request.requiresOnDeviceRecognition = true; request.shouldReportPartialResults = false
                let id = UUID(); recognitionID = id
                text = try await withCheckedThrowingContinuation { continuation in
                    recognitionWaiter = continuation
                    recognition = recognizer.recognitionTask(with: request) { @Sendable [weak self] result, error in
                        let final = result?.isFinal == true ? result?.bestTranscription.formattedString : nil
                        Task { @MainActor in
                            guard let self, self.recognitionID == id else { return }
                            if let final { self.resolveRecognition(.success(final)) }
                            else if let error { self.resolveRecognition(.failure(error)) }
                        }
                    }
                    recognitionTimeout = Task {
                        do { try await Task.sleep(for: .seconds(60)) } catch { return }
                        guard self.recognitionID == id else { return }
                        self.recognition?.cancel(); self.resolveRecognition(.failure(PilotError("Transcription took too long. Your recording is safe; retry when ready.")))
                    }
                }
            }
            guard current == model.connectionID else { throw CancellationError() }
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PilotError("No speech was detected. You can retry or discard the recording.") }
            return text
        } catch { self.error = error.localizedDescription; throw error }
    }

    private func resolveRecognition(_ result: Result<String, Error>) {
        recognitionTimeout?.cancel(); recognitionTimeout = nil; recognition = nil
        let waiter = recognitionWaiter; recognitionWaiter = nil
        waiter?.resume(with: result)
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let id = ObjectIdentifier(recorder)
        Task { @MainActor in if self.recording, self.recorder.map(ObjectIdentifier.init) == id { self.interrupted() } }
    }
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        let message = error?.localizedDescription ?? "Recording stopped unexpectedly. Your captured audio is retained."
        let id = ObjectIdentifier(recorder)
        Task { @MainActor in
            guard self.recorder.map(ObjectIdentifier.init) == id else { return }
            self.finishRecording(); self.error = message
        }
    }
}
