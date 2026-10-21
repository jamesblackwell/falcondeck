import AVFoundation
import Foundation
import Observation
import Speech

@MainActor @Observable
final class VoiceRecorder: NSObject, AVAudioRecorderDelegate {
    var recording = false
    var starting = false
    var transcribing = false
    var acceptingTranscript = false
    var waitingForConnection = false
    var elapsed: TimeInterval = 0
    var level: Float = 0
    var levels: [Float] = []
    var transcriptionAttempt = 1
    var error: String?
    private(set) var ownerID: String?
    private(set) var pendingURL: URL?
    // Legacy saved audio with no provenance stays local. New recordings use the
    // selected provider, whose default is the paired computer.
    private(set) var provider = "on-device"
    @ObservationIgnored private var ownsAudioSession = false
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var meter: Task<Void, Never>?
    @ObservationIgnored private var recognition: SFSpeechRecognitionTask?
    @ObservationIgnored private var recognitionWaiter: CheckedContinuation<String, Error>?
    @ObservationIgnored private var recognitionTimeout: Task<Void, Never>?
    @ObservationIgnored private var recognitionID = UUID()
    @ObservationIgnored private var interruptions: AudioInterruptionObserver?
    @ObservationIgnored private var operationID = UUID()

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let requestPermission: @MainActor () async -> Bool

    override convenience init() { self.init(defaults: .standard) }
    init(defaults: UserDefaults, requestPermission: @escaping @MainActor () async -> Bool = { await AVAudioApplication.requestRecordPermission() }) {
        self.defaults = defaults; self.requestPermission = requestPermission
        super.init()
        interruptions = AudioInterruptionObserver { [weak self] in self?.interrupted() }
        if let path = defaults.string(forKey: "native.voice.pending"), FileManager.default.fileExists(atPath: path) {
            pendingURL = URL(fileURLWithPath: path)
            ownerID = defaults.string(forKey: "native.voice.owner")
            provider = defaults.string(forKey: "native.voice.provider") ?? "on-device"
            let savedDuration = defaults.double(forKey: "native.voice.duration")
            elapsed = savedDuration.isFinite && savedDuration > 0 ? savedDuration : 0
        }
    }

    func start(ownerID: String, provider: String, isCurrent: () -> Bool = { true }) async {
        guard !starting, !recording, !transcribing, !acceptingTranscript, pendingURL == nil else { return }
        let operation = UUID(); operationID = operation
        self.ownerID = ownerID; self.provider = provider
        starting = true; elapsed = 0; levels = []
        defer { if operationID == operation { starting = false } }
        error = nil
        // Capture is local. Connection and API-key failures belong to the
        // upload step; neither should prevent the user recording their words.
        let permitted = await requestPermission()
        guard isCurrent(), operationID == operation, !Task.isCancelled else { return }
        guard permitted else { error = "Allow microphone access in Settings to record a message."; return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            ownsAudioSession = true
            let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appending(path: "Voice", directoryHint: .isDirectory)
            // Lock Screen Finish reopens finalized recordings for transcription.
            let protection: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: protection)
            try FileManager.default.setAttributes(protection, ofItemAtPath: directory.path)
            var protectedDirectory = directory
            var resourceValues = URLResourceValues(); resourceValues.isExcludedFromBackup = true
            try protectedDirectory.setResourceValues(resourceValues)
            let url = directory.appending(path: "\(UUID()).m4a")
            let recorder = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: NativeSpeechSettings.recordingBitRate])
            recorder.delegate = self; recorder.isMeteringEnabled = true
            guard recorder.record() else { throw PilotError("Couldn't start the microphone.") }
            self.recorder = recorder; pendingURL = url; self.ownerID = ownerID; self.provider = provider
            defaults.set(url.path, forKey: "native.voice.pending")
            defaults.set(ownerID, forKey: "native.voice.owner")
            defaults.set(provider, forKey: "native.voice.provider")
            defaults.removeObject(forKey: "native.voice.duration")
            recording = true; elapsed = 0
            SpeechLiveActivity.shared.voice("listening")
            meter = Task {
                while !Task.isCancelled, self.recording {
                    if self.recorder?.isRecording != true { self.interrupted(); return }
                    self.recorder?.updateMeters()
                    self.updateCapture(elapsed: self.recorder?.currentTime ?? self.elapsed,
                        level: min(1, max(0, 1 + (self.recorder?.averagePower(forChannel: 0) ?? -60) / 50)))
                    do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                }
            }
        } catch { self.error = error.localizedDescription; releaseAudioSession() }
    }

    func updateCapture(elapsed: TimeInterval, level: Float) {
        guard recording else { return }
        self.elapsed = elapsed; self.level = level
        levels = Array(levels.suffix(119)) + [level]
        if elapsed >= NativeSpeechSettings.maximumRecordingDuration { finishRecording() }
    }

    func finishRecording() {
        if let recorder { elapsed = max(elapsed, recorder.currentTime) }
        recorder?.stop(); recorder = nil; meter?.cancel(); meter = nil; recording = false; level = 0
        if pendingURL != nil { defaults.set(elapsed, forKey: "native.voice.duration") }
        SpeechLiveActivity.shared.voice(nil)
        releaseAudioSession()
    }
    private func releaseAudioSession() {
        guard ownsAudioSession else { return }
        ownsAudioSession = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func discard() {
        finishRecording(); cancelTranscription()
        if let pendingURL { try? FileManager.default.removeItem(at: pendingURL) }
        pendingURL = nil; ownerID = nil; error = nil; levels = []; elapsed = 0; transcriptionAttempt = 1
        defaults.removeObject(forKey: "native.voice.pending")
        defaults.removeObject(forKey: "native.voice.owner")
        defaults.removeObject(forKey: "native.voice.provider")
        defaults.removeObject(forKey: "native.voice.duration")
    }

    /// Explicit recovery transfers this clip, never silently changes its provider.
    @discardableResult func recover(ownerID: String) -> Bool {
        guard pendingURL != nil, !acceptingTranscript else { return false }
        finishRecording(); cancelTranscription()
        self.ownerID = ownerID; defaults.set(ownerID, forKey: "native.voice.owner")
        return true
    }

    func cancelTranscription() {
        operationID = UUID(); starting = false; transcribing = false; waitingForConnection = false
        recognition?.cancel(); resolveRecognition(.failure(CancellationError()))
        SpeechLiveActivity.shared.voice(nil)
    }

    func interrupted() {
        guard recording else { return }
        finishRecording()
        error = "Recording was interrupted. Your captured audio is safe; transcribe or discard it when ready."
    }

    func transcribe(model: AppModel, using providerOverride: String? = nil) async throws -> String {
        guard !transcribing, !acceptingTranscript, let url = pendingURL else { throw PilotError("Record a message first.") }
        let operation = UUID(); operationID = operation
        let lease = model.backgroundExecution.begin("Transcribe voice message") { [weak self] in
            guard let self, self.operationID == operation else { return }
            self.cancelTranscription()
            self.error = "Transcription paused in the background. Your recording is safe; retry when ready."
        }
        defer { lease.finish() }
        if let providerOverride { provider = providerOverride; defaults.set(providerOverride, forKey: "native.voice.provider") }
        finishRecording(); transcribing = true; transcriptionAttempt = 1; error = nil
        SpeechLiveActivity.shared.voice("transcribing")
        defer { if operationID == operation { transcribing = false; waitingForConnection = false; SpeechLiveActivity.shared.voice(nil) } }
        let current = model.sessionScope
        let text: String
        do {
            if provider == "openrouter" {
                let audio = try await Task.detached {
                    let data = try Data(contentsOf: url)
                    try NativeSpeechSettings.validateAudio(data)
                    return data
                }.value
                guard current == model.sessionScope, operationID == operation else { throw CancellationError() }
                let params = try NativeSpeechSettings.parameters(audio: audio, defaults: defaults, duration: elapsed)
                text = try await SpeechTranscription.transcribe(params: params, relay: model.relay, isCurrent: { current == model.sessionScope && self.operationID == operation }, onAttempt: { self.transcriptionAttempt = $0 }, beforeAttempt: {
                    defer { if self.operationID == operation { self.waitingForConnection = false } }
                    try await SpeechConnection.waitUntilReady(isReady: { model.connected }, isCurrent: { current == model.sessionScope && self.operationID == operation }, onWait: { self.waitingForConnection = true })
                })
            } else {
                let authorization = await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { @Sendable status in continuation.resume(returning: status) } }
                guard current == model.sessionScope, operationID == operation, !Task.isCancelled else { throw CancellationError() }
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
            guard current == model.sessionScope, operationID == operation, !Task.isCancelled else { throw CancellationError() }
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PilotError("No speech was detected. You can retry or discard the recording.") }
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            guard current == model.sessionScope, operationID == operation else { throw CancellationError() }
            if !(error is CancellationError) { self.error = error.localizedDescription }
            throw error
        }
    }

    private func resolveRecognition(_ result: Result<String, Error>) {
        recognitionTimeout?.cancel(); recognitionTimeout = nil; recognition = nil
        let waiter = recognitionWaiter; recognitionWaiter = nil
        waiter?.resume(with: result)
    }
    #if DEBUG
    /// Local screenshot fixtures never open a microphone, file or relay request.
    func preview(_ phase: String, ownerID: String) {
        self.ownerID = ownerID; provider = "openrouter"
        elapsed = phase == "long" ? 15 * 60 : phase == "limit" ? NativeSpeechSettings.maximumRecordingDuration : phase == "ready" || phase == "other-task" ? 0 : 42
        pendingURL = phase == "starting" ? nil : FileManager.default.temporaryDirectory.appending(path: "voice-ui-preview.m4a")
        starting = phase == "starting"; recording = phase == "recording" || phase == "long"; transcribing = phase == "transcribing"
        levels = (0..<100).map { Float(abs(sin(Double($0) * 0.43))) * 0.8 }
        error = phase == "failed" ? "Could not reach your computer. Your recording is safe, so you can retry." : nil
    }
    #endif
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
