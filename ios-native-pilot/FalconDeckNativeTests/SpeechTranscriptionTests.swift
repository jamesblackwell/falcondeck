import AVFoundation
import XCTest
@testable import FalconDeckNative

@MainActor final class SpeechTranscriptionTests: XCTestCase {
    private func inputStore() throws -> DraftStore {
        let root = FileManager.default.temporaryDirectory.appending(path: "SpeechDraft-\(UUID())")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let session = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "fixture", deviceID: "fixture", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        return try DraftStore(session: session, root: root)
    }
    private func defaults() -> (UserDefaults, String) {
        let suite = "NativeSpeechTests-" + UUID().uuidString
        return (UserDefaults(suiteName: suite)!, suite)
    }
    private func recording(defaults: UserDefaults, owner: String = "owner") throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".m4a")
        try Data([1, 2, 3]).write(to: url)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        defaults.set(url.path, forKey: "native.voice.pending")
        defaults.set(owner, forKey: "native.voice.owner")
        defaults.set("openrouter", forKey: "native.voice.provider")
        return url
    }
    func testCaptureContinuesPastThreeAndFifteenMinutesAndKeepsAudioAtThirty() throws {
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let url = try recording(defaults: defaults), voice = VoiceRecorder(defaults: defaults)
        voice.recording = true
        for time in [180.0, 900.0, 1799.0] {
            voice.updateCapture(elapsed: time, level: 0.5)
            XCTAssertTrue(voice.recording, "Capture must still be running at \(time) seconds")
            XCTAssertEqual(voice.pendingURL, url)
        }
        voice.updateCapture(elapsed: 1800, level: 0.5)
        XCTAssertFalse(voice.recording); XCTAssertEqual(voice.elapsed, 1800)
        XCTAssertEqual(voice.pendingURL, url); XCTAssertEqual(voice.ownerID, "owner")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path)); XCTAssertNil(voice.error)
        XCTAssertEqual(defaults.double(forKey: "native.voice.duration"), 1800)
        let restored = VoiceRecorder(defaults: defaults)
        XCTAssertEqual(restored.elapsed, 1800); XCTAssertEqual(restored.pendingURL, url)
    }
    func testRecoveredLongRecordingSendsDurationAndSurvivesTranscriptionFailure() async throws {
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let url = try recording(defaults: defaults)
        defaults.set(1800.0, forKey: "native.voice.duration")
        let voice = VoiceRecorder(defaults: defaults)
        let relay = SpeechFixtureRelay(failures: 1, failure: "OpenRouter API key was rejected")
        let model = AppModel.testing(relay: relay, voice: voice); model.connected = true
        do { _ = try await voice.transcribe(model: model); XCTFail("Expected the fixture failure") }
        catch { XCTAssertEqual(error.localizedDescription, "OpenRouter API key was rejected") }
        let calls = await relay.calls
        XCTAssertEqual(calls.count, 1); XCTAssertEqual(calls.first?.1["duration_seconds"], .number(1800))
        XCTAssertEqual(voice.pendingURL, url); XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        voice.discard()
        XCTAssertNil(defaults.object(forKey: "native.voice.duration"))
    }
    func testLongRecordingResponseDeadlineCoversDaemonFallbackWithoutSlowingShortDictation() {
        let short = JSON.object(["duration_seconds": .number(42)])
        XCTAssertEqual(NativeSpeechSettings.responseTimeout(params: short), .seconds(120))
        for seconds in [900.0, 1800.0, 86_400.0] {
            XCTAssertEqual(NativeSpeechSettings.responseTimeout(params: .object(["duration_seconds": .number(seconds)])), .seconds(930))
        }
        let recovered = JSON.object(["audio_base64": .string(String(repeating: "A", count: 960_000))])
        XCTAssertEqual(NativeSpeechSettings.responseTimeout(params: recovered), .seconds(240))
        for invalid in [-1.0, .infinity, .nan] {
            XCTAssertEqual(NativeSpeechSettings.responseTimeout(params: recovered.setting("duration_seconds", .number(invalid))), .seconds(240))
        }
    }
    func testThirtyMinuteAACCaptureFitsExistingSpeechAndEncryptedRelayLimits() async throws {
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let url = FileManager.default.temporaryDirectory.appending(path: "HalfHour-\(UUID()).m4a")
        defer { try? FileManager.default.removeItem(at: url) }
        // Encode the full half hour offline; this never opens a microphone or
        // sends audio to a service. Reuse one PCM buffer to keep memory bounded.
        try autoreleasepool {
            let file = try AVAudioFile(forWriting: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: NativeSpeechSettings.recordingBitRate])
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 16_000))
            buffer.frameLength = 16_000
            let samples = try XCTUnwrap(buffer.floatChannelData?.pointee)
            var seed: UInt32 = 7
            for frame in 0..<16_000 {
                seed = seed &* 1_664_525 &+ 1_013_904_223
                samples[frame] = (Float(seed) / Float(UInt32.max) - 0.5) * 0.2
            }
            for _ in 0..<1800 { try file.write(from: buffer) }
        }
        let duration = try await AVURLAsset(url: url).load(.duration).seconds
        XCTAssertEqual(duration, 1800, accuracy: 0.25)
        let audio = try Data(contentsOf: url)
        XCTAssertLessThan(audio.count, NativeSpeechSettings.maximumAudioBytes)
        let params = try NativeSpeechSettings.parameters(audio: audio, defaults: defaults, duration: duration)
        let frame = JSON.object(["type": .string("rpc-call"), "request_id": .string("local-long-recording-test"), "method": .string("speech.transcribe"), "params": try RelayCrypto.encrypt(params, key: Data(repeating: 7, count: 32))])
        XCTAssertLessThan(try frame.wireText().utf8.count, 16 * 1024 * 1024)
    }
    func testDeleteCancelsTranscriptionClearsRecoveryAndKeepsTheTypedDraft() async throws {
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let url = try recording(defaults: defaults)
        let voice = VoiceRecorder(defaults: defaults), relay = SpeechFixtureRelay(blocked: true)
        let model = AppModel.testing(relay: relay, voice: voice); model.connected = true
        let chat = model.chat(for: AgentTask(.object(["id": .string("owner")])))
        chat.draft = "Keep my typed message"; chat.voiceInputOpen = true
        voice.elapsed = 42
        let work = Task { try await voice.transcribe(model: model) }
        await relay.waitForRequest()
        XCTAssertTrue(model.discardVoiceInput())
        XCTAssertFalse(chat.voiceInputOpen); XCTAssertEqual(chat.draft, "Keep my typed message")
        XCTAssertNil(voice.pendingURL); XCTAssertNil(voice.ownerID); XCTAssertEqual(voice.elapsed, 0)
        XCTAssertFalse(voice.recording); XCTAssertFalse(voice.transcribing); XCTAssertFalse(voice.starting)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        for key in ["pending", "owner", "provider"] { XCTAssertNil(defaults.object(forKey: "native.voice." + key)) }
        XCTAssertNil(VoiceRecorder(defaults: defaults).pendingURL)
        await relay.completeRequest()
        do { _ = try await work.value; XCTFail("Deleted recordings must ignore late replies") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertNil(voice.error); XCTAssertEqual(chat.draft, "Keep my typed message")
    }
    func testExplicitRecoveryTransfersTheClipWithoutChangingItsProviderOrDrafts() async throws {
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let url = try recording(defaults: defaults)
        let voice = VoiceRecorder(defaults: defaults), relay = SpeechFixtureRelay(blocked: true)
        let model = AppModel.testing(relay: relay, voice: voice); model.connected = true
        let old = model.chat(for: AgentTask(.object(["id": .string("owner")])))
        let task = AgentTask(.object(["id": .string("new-task")]))
        let next = model.chat(for: task)
        old.draft = "Original draft"; old.voiceInputOpen = true; next.draft = "New draft"
        let work = Task { try await voice.transcribe(model: model) }; await relay.waitForRequest()
        XCTAssertTrue(model.recoverVoiceInput(in: task))
        XCTAssertEqual(voice.pendingURL, url); XCTAssertEqual(voice.ownerID, task.id); XCTAssertEqual(voice.provider, "openrouter")
        XCTAssertEqual(defaults.string(forKey: "native.voice.owner"), task.id)
        XCTAssertFalse(voice.transcribing); XCTAssertFalse(old.voiceInputOpen); XCTAssertTrue(next.voiceInputOpen)
        XCTAssertEqual(old.draft, "Original draft"); XCTAssertEqual(next.draft, "New draft")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        let restored = VoiceRecorder(defaults: defaults)
        XCTAssertEqual(restored.ownerID, task.id); XCTAssertEqual(restored.pendingURL, url); XCTAssertEqual(restored.provider, "openrouter")
        await relay.completeRequest()
        do { _ = try await work.value; XCTFail("Transferred clips must ignore the previous request") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(next.draft, "New draft")
    }
    func testRecoveryActionsCannotInterruptTheDurableTranscriptHandoff() throws {
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let url = try recording(defaults: defaults)
        let voice = VoiceRecorder(defaults: defaults), model = AppModel.testing(relay: SpeechFixtureRelay(), voice: voice)
        voice.acceptingTranscript = true
        XCTAssertFalse(model.discardVoiceInput())
        XCTAssertFalse(model.recoverVoiceInput(in: AgentTask(.object(["id": .string("new-task")]))))
        XCTAssertEqual(voice.ownerID, "owner"); XCTAssertEqual(voice.pendingURL, url)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }
    func testAnOldTranscriptCannotConsumeANewerRecordingInTheSameTask() async throws {
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let old = try recording(defaults: defaults), current = try recording(defaults: defaults)
        let voice = VoiceRecorder(defaults: defaults), model = AppModel.testing(relay: SpeechFixtureRelay(), voice: voice)
        model.draftStore = try inputStore()
        let chat = model.chat(for: AgentTask(.object(["id": .string("owner")])))
        chat.draft = "Keep current input"
        let result = await model.finishVoiceInput("Stale transcript", ownerID: "owner", chat: chat, recording: old)
        XCTAssertNil(result); XCTAssertEqual(chat.draft, "Keep current input")
        XCTAssertEqual(voice.pendingURL, current); XCTAssertTrue(FileManager.default.fileExists(atPath: current.path))
    }
    func testDeleteWhilePermissionIsPendingCannotStartALateRecording() async {
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let requested = expectation(description: "Microphone permission requested")
        var permission: CheckedContinuation<Bool, Never>?
        let voice = VoiceRecorder(defaults: defaults, requestPermission: {
            await withCheckedContinuation { permission = $0; requested.fulfill() }
        })
        let model = AppModel.testing(relay: SpeechFixtureRelay(), voice: voice)
        let work = Task { await voice.start(ownerID: "owner", provider: "openrouter") }
        await fulfillment(of: [requested], timeout: 2)
        XCTAssertTrue(model.discardVoiceInput())
        permission?.resume(returning: true); await work.value
        XCTAssertFalse(voice.recording); XCTAssertFalse(voice.starting); XCTAssertNil(voice.pendingURL); XCTAssertNil(voice.ownerID)
    }
    func testComputerIsDefaultAndExplicitLocalChoiceIsPreserved() throws {
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(NativeSpeechSettings.provider(in: defaults), "openrouter")
        defaults.set("on-device", forKey: "native.speech.provider")
        XCTAssertEqual(NativeSpeechSettings.provider(in: defaults), "on-device")
        defaults.set("  ", forKey: "native.speech.model")
        defaults.set(" en ", forKey: "native.speech.language")
        let params = try NativeSpeechSettings.parameters(audio: Data([1, 2, 3]), defaults: defaults)
        XCTAssertEqual(params["model"].string, "openai/gpt-4o-mini-transcribe")
        XCTAssertEqual(params["language"].string, "en")
        XCTAssertEqual(params["format"].string, "m4a")
        XCTAssertEqual(Data(base64Encoded: params["audio_base64"].string), Data([1, 2, 3]))
        XCTAssertThrowsError(try NativeSpeechSettings.parameters(audio: Data(), defaults: defaults))
        XCTAssertThrowsError(try NativeSpeechSettings.parameters(audio: Data(count: 8 * 1024 * 1024 + 1), defaults: defaults))
    }
    func testTransientFailuresRetryTheSameRequestAndReportAttempts() async throws {
        let relay = SpeechFixtureRelay(failures: 2)
        let params = JSON.object(["model": .string("selected-model"), "audio_base64": .string("fixture")])
        var attempts: [Int] = [], delays: [Duration] = []
        let text = try await SpeechTranscription.transcribe(params: params, relay: relay, isCurrent: { true }, onAttempt: { attempts.append($0) }, wait: { delays.append($0) })
        XCTAssertEqual(text, "A clear transcript.")
        XCTAssertEqual(attempts, [1, 2, 3]); XCTAssertEqual(delays, [.milliseconds(500), .seconds(1)])
        let calls = await relay.calls
        XCTAssertEqual(calls.count, 3)
        XCTAssertTrue(calls.allSatisfy { $0.0 == "speech.transcribe" && $0.1 == params })
    }
    func testPermanentErrorsDoNotRetryAndTransientRetriesAreBounded() async {
        for (message, expected) in [("OpenRouter API key was rejected", 1), ("Connect to your computer first.", 10)] {
            let relay = SpeechFixtureRelay(failures: 20, failure: message)
            do {
                _ = try await SpeechTranscription.transcribe(params: .null, relay: relay, isCurrent: { true }, onAttempt: { _ in }, wait: { _ in })
                XCTFail("Expected transcription to fail")
            } catch { XCTAssertEqual(error.localizedDescription, message) }
            let calls = await relay.calls
            XCTAssertEqual(calls.count, expected)
        }
    }
    func testCancellationDuringRetryNeverStartsAnotherRequest() async {
        let relay = SpeechFixtureRelay(failures: 2)
        var current = true
        do {
            _ = try await SpeechTranscription.transcribe(params: .null, relay: relay, isCurrent: { current }, onAttempt: { _ in }, wait: { _ in current = false })
            XCTFail("Expected cancellation")
        } catch { XCTAssertTrue(error is CancellationError) }
        let calls = await relay.calls
        XCTAssertEqual(calls.count, 1)
    }
    func testCancellingCloudTranscriptionKeepsAudioAndRejectsItsLateReply() async throws {
        let (defaults, suite) = defaults()
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".m4a")
        try Data([1, 2, 3]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url); defaults.removePersistentDomain(forName: suite) }
        defaults.set(url.path, forKey: "native.voice.pending")
        defaults.set("owner", forKey: "native.voice.owner")
        defaults.set("openrouter", forKey: "native.voice.provider")
        let voice = VoiceRecorder(defaults: defaults), relay = SpeechFixtureRelay(blocked: true)
        let model = AppModel.testing(relay: relay, voice: voice); model.connected = true
        let work = Task { try await voice.transcribe(model: model) }
        await relay.waitForRequest()
        XCTAssertTrue(voice.transcribing)
        voice.cancelTranscription()
        XCTAssertFalse(voice.transcribing)
        XCTAssertEqual(voice.pendingURL, url)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        await relay.completeRequest()
        do { _ = try await work.value; XCTFail("A cancelled reply must not be inserted or sent") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertNil(voice.error)
        XCTAssertEqual(voice.pendingURL, url)
    }
    func testCloudRecordingDoesNotWaitForConnectionOrAnOpenRouterKey() async {
        for online in [false, true] {
            let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
            let relay = SpeechFixtureRelay(configured: false)
            var permissionRequested = false
            let voice = VoiceRecorder(defaults: defaults, requestPermission: { permissionRequested = true; return false })
            let model = AppModel.testing(relay: relay, voice: voice); model.connected = online
            await voice.start(ownerID: "owner", provider: "openrouter")
            XCTAssertTrue(permissionRequested, "Local recording must reach microphone permission even while reconnecting")
            XCTAssertTrue(voice.error?.contains("microphone") == true)
            let calls = await relay.calls; XCTAssertTrue(calls.isEmpty, "Opening the microphone must not perform a network preflight")
        }
    }
    func testReconnectDoesNotInterruptLocalRecording() async throws {
        let (defaults, suite) = defaults(); defer { defaults.removePersistentDomain(forName: suite) }
        let voice = VoiceRecorder(defaults: defaults), model = AppModel.testing(relay: SpeechFixtureRelay(), voice: voice)
        model.hasSession = true; model.connected = true
        voice.recording = true
        await model.reconnect()
        XCTAssertTrue(voice.recording, "A relay reconnect must not stop local audio capture")
        voice.finishRecording()
    }
    func testConnectionWaitIsBoundedAndCancelledBeforeSendingToANewSession() async throws {
        var waits = 0
        do {
            try await SpeechConnection.waitUntilReady(isReady: { false }, isCurrent: { true }, wait: { _ in waits += 1 })
            XCTFail("Expected reconnect timeout")
        } catch { XCTAssertTrue(error.localizedDescription.contains("reconnecting")) }
        XCTAssertEqual(waits, 120)
        var current = true
        do {
            try await SpeechConnection.waitUntilReady(isReady: { false }, isCurrent: { current }, wait: { _ in current = false })
            XCTFail("Expected cancellation after a pairing switch")
        } catch { XCTAssertTrue(error is CancellationError) }
    }
    func testCloudTranscriptionCanWaitAcrossReconnectAndRetainsItsRecording() async throws {
        let (defaults, suite) = defaults(), relay = SpeechFixtureRelay()
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".m4a")
        try Data([1, 2, 3]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url); defaults.removePersistentDomain(forName: suite) }
        defaults.set(url.path, forKey: "native.voice.pending"); defaults.set("owner", forKey: "native.voice.owner"); defaults.set("openrouter", forKey: "native.voice.provider")
        let voice = VoiceRecorder(defaults: defaults), model = AppModel.testing(relay: relay, voice: voice)
        model.hasSession = true
        let scope = model.sessionScope
        let work = Task { try await voice.transcribe(model: model) }
        for _ in 0..<200 where !voice.waitingForConnection { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(voice.waitingForConnection)
        let before = await relay.calls; XCTAssertTrue(before.isEmpty)
        await model.reconnect()
        XCTAssertEqual(model.sessionScope, scope)
        XCTAssertTrue(voice.transcribing)
        model.connected = true
        let result = try await work.value; XCTAssertEqual(result, "A clear transcript.")
        XCTAssertFalse(voice.waitingForConnection)
        XCTAssertEqual(voice.pendingURL, url)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }
    func testForgettingWhileWaitingCannotUploadAudioToAnotherPairing() async throws {
        let (defaults, suite) = defaults(), relay = SpeechFixtureRelay()
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".m4a")
        try Data([1]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url); defaults.removePersistentDomain(forName: suite) }
        defaults.set(url.path, forKey: "native.voice.pending"); defaults.set("openrouter", forKey: "native.voice.provider")
        let voice = VoiceRecorder(defaults: defaults), model = AppModel.testing(relay: relay, voice: voice)
        let scope = model.sessionScope
        let work = Task { try await voice.transcribe(model: model) }
        for _ in 0..<200 where !voice.waitingForConnection { try await Task.sleep(for: .milliseconds(5)) }
        await model.forget(); model.connected = true
        XCTAssertNotEqual(model.sessionScope, scope)
        do { _ = try await work.value; XCTFail("Expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
        let calls = await relay.calls; XCTAssertTrue(calls.isEmpty)
        XCTAssertEqual(voice.pendingURL, url)
    }
    func testAnArchivedOrReplacedChatCannotConsumeItsSavedRecording() async throws {
        let (defaults, suite) = defaults()
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".m4a")
        try Data([1]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url); defaults.removePersistentDomain(forName: suite) }
        defaults.set(url.path, forKey: "native.voice.pending"); defaults.set("owner", forKey: "native.voice.owner")
        let voice = VoiceRecorder(defaults: defaults), model = AppModel.testing(relay: SpeechFixtureRelay(), voice: voice)
        model.draftStore = try inputStore()
        let chat = model.chat(for: AgentTask(.object(["id": .string("owner")])))
        chat.draft = "Keep draft"; chat.voiceInputOpen = true
        model.chats.removeValue(forKey: "owner")
        let removed = await model.finishVoiceInput("Transcript", ownerID: "owner", chat: chat)
        XCTAssertNil(removed)
        XCTAssertEqual(voice.pendingURL, url); XCTAssertEqual(chat.draft, "Keep draft")
        model.chats["owner"] = ChatSession()
        let replaced = await model.finishVoiceInput("Transcript", ownerID: "owner", chat: chat)
        XCTAssertNil(replaced)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        // The rightful current draft consumes the recording only after insertion.
        let current = model.chats["owner"]!
        let accepted = await model.finishVoiceInput("Transcript", ownerID: "owner", chat: current)
        XCTAssertNotNil(accepted)
        XCTAssertEqual(current.draft, "Transcript"); XCTAssertNil(voice.pendingURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
    func testLockScreenFinishUsesTheSameCapturedDraftSelection() async throws {
        let (defaults, suite) = defaults()
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".m4a")
        try Data([1]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url); defaults.removePersistentDomain(forName: suite) }
        defaults.set(url.path, forKey: "native.voice.pending")
        defaults.set("owner", forKey: "native.voice.owner"); defaults.set("openrouter", forKey: "native.voice.provider")
        let voice = VoiceRecorder(defaults: defaults), relay = SpeechFixtureRelay(transcript: "lexer")
        let model = AppModel.testing(relay: relay, voice: voice); model.connected = true
        let store = try inputStore(); model.draftStore = store
        let task = AgentTask(.object(["id": .string("owner"), "workspace_id": .string("project")]))
        let chat = model.chat(for: task)
        chat.draft = "Fix parser"; chat.voiceInputOpen = true
        chat.voiceInsertion = VoiceDraftInsertion(original: chat.draft, selection: NSRange(location: 4, length: 6))
        voice.recording = true
        await model.speechAction(.finish)
        XCTAssertEqual(chat.draft, "Fix lexer")
        XCTAssertNil(chat.voiceInsertion); XCTAssertFalse(chat.voiceInputOpen)
        XCTAssertNil(voice.pendingURL); XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        let recovered = try await store.load()
        XCTAssertEqual(recovered.first?.text, "Fix lexer", "Lock Screen finish saves the draft before deleting its recording")
    }
    func testFailedDraftWriteKeepsTheRecordingAndOriginalInput() async throws {
        let (defaults, suite) = defaults(), store = try inputStore()
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".m4a")
        try Data([1]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url); defaults.removePersistentDomain(forName: suite) }
        defaults.set(url.path, forKey: "native.voice.pending"); defaults.set("owner", forKey: "native.voice.owner")
        let voice = VoiceRecorder(defaults: defaults), model = AppModel.testing(relay: SpeechFixtureRelay(), voice: voice)
        model.draftStore = store
        let chat = model.chat(for: AgentTask(.object(["id": .string("owner")])))
        chat.draft = "Keep original"; chat.voiceInputOpen = true
        try await store.clear()
        let result = await model.finishVoiceInput("Transcript", ownerID: "owner", chat: chat)
        XCTAssertNil(result); XCTAssertEqual(chat.draft, "Keep original")
        XCTAssertTrue(chat.voiceInputOpen); XCTAssertFalse(voice.acceptingTranscript)
        XCTAssertEqual(voice.pendingURL, url); XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertTrue(voice.error?.contains("recording is safe") == true)
    }
    func testBackgroundExpirationKeepsAudioAndRejectsALateCloudReply() async throws {
        let (defaults, suite) = defaults()
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".m4a")
        try Data([1]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url); defaults.removePersistentDomain(forName: suite) }
        defaults.set(url.path, forKey: "native.voice.pending"); defaults.set("owner", forKey: "native.voice.owner"); defaults.set("openrouter", forKey: "native.voice.provider")
        let voice = VoiceRecorder(defaults: defaults), relay = SpeechFixtureRelay(blocked: true), provider = BackgroundTaskFixture()
        let model = AppModel(relay: relay, voice: voice, push: NativePushNotifications(defaults: defaults), notifications: LocalNotifications(defaults: defaults), backgroundExecution: BackgroundExecution(provider: provider), sessionLoader: { nil })
        model.connected = true
        let work = Task { try await voice.transcribe(model: model) }
        await relay.waitForRequest()
        provider.expire(1)
        XCTAssertFalse(voice.transcribing); XCTAssertEqual(voice.pendingURL, url)
        await relay.completeRequest()
        do { _ = try await work.value; XCTFail("Expired transcription must reject late replies") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path)); XCTAssertEqual(provider.ended, [1])
    }
    func testVoiceInsertionPreservesUnicodeSelectionAndAnAsyncDraftEdit() {
        let draft = "Fix 🦅 parser"
        let selected = draft.range(of: "parser")!
        let edit = VoiceDraftInsertion(original: draft, selection: NSRange(selected, in: draft))
        let result = edit.inserting(" lexer ", into: draft)
        XCTAssertEqual(result.text, "Fix 🦅 lexer")
        XCTAssertEqual(result.caret, result.text.endIndex)
        let changed = edit.inserting("next", into: "A different draft")
        XCTAssertEqual(changed.text, "A different draft next")
        let middle = VoiceDraftInsertion(original: "Fix the parser", selection: NSRange(location: 8, length: 0)).inserting("obvious", into: "Fix the parser")
        XCTAssertEqual(middle.text, "Fix the obvious parser")
        XCTAssertEqual(String(middle.text[..<middle.caret]), "Fix the obvious")
    }
    func testCanonicallyEquivalentDraftChangesCannotReuseOldUTF16Offsets() {
        let original = "e\u{301}x", changed = "éx"
        XCTAssertEqual(original, changed)
        let edit = VoiceDraftInsertion(original: original, selection: NSRange(location: 0, length: 2))
        XCTAssertEqual(edit.inserting("next", into: changed).text, "éx next")
    }
    func testStaleCursorIndicesAfterClearingOrShorteningTheDraftAreSafe() {
        let old = "A long draft with 🦅 Unicode that will be cleared before recording."
        let caret = old.endIndex..<old.endIndex
        for draft in ["", "Short"] {
            let insertion = VoiceDraftInsertion.capture(caret, in: draft)
            XCTAssertNil(insertion.selection)
            XCTAssertEqual(insertion.inserting("dictation", into: draft).text, draft.isEmpty ? "dictation" : draft + " dictation")
        }
        let selected = old.range(of: "Unicode")!
        let captured = VoiceDraftInsertion.capture(selected, in: old)
        XCTAssertEqual(captured.selection, NSRange(selected, in: old))
        XCTAssertTrue(captured.inserting("speech", into: old).text.contains("🦅 speech that"))
        XCTAssertEqual(captured.inserting("speech", into: "A new draft").text, "A new draft speech")
        XCTAssertEqual(VoiceDraftInsertion.capture("".startIndex..<"".endIndex, in: "").selection, NSRange(location: 0, length: 0))
    }
}

private actor SpeechFixtureRelay: RelayServing {
    var calls: [(String, JSON)] = []
    let failure: String
    private var failures: Int
    private let configured: Bool
    private let blocked: Bool
    private let transcript: String
    private var pending: CheckedContinuation<JSON, Error>?
    private var ready: CheckedContinuation<Void, Never>?
    init(failures: Int = 0, failure: String = "Transient connection failure", configured: Bool = true, blocked: Bool = false, transcript: String = "A clear transcript.") {
        self.failures = failures; self.failure = failure; self.configured = configured; self.blocked = blocked; self.transcript = transcript
    }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async throws -> JSON {
        calls.append((method, params))
        if method == "speech.status" { return .object(["configured": .bool(configured)]) }
        if failures > 0 { failures -= 1; throw PilotError(failure) }
        if blocked {
            return try await withCheckedThrowingContinuation { pending = $0; ready?.resume(); ready = nil }
        }
        return .object(["text": .string(" " + transcript + " ")])
    }
    func waitForRequest() async {
        if pending != nil { return }
        await withCheckedContinuation { ready = $0 }
    }
    func completeRequest() { pending?.resume(returning: .object(["text": .string("Late transcript")])); pending = nil }
}
