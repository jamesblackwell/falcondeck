import XCTest
@testable import FalconDeckNative

@MainActor final class SpeechTranscriptionTests: XCTestCase {
    private func defaults() -> (UserDefaults, String) {
        let suite = "NativeSpeechTests-" + UUID().uuidString
        return (UserDefaults(suiteName: suite)!, suite)
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
    func testAnArchivedOrReplacedChatCannotConsumeItsSavedRecording() throws {
        let (defaults, suite) = defaults()
        let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".m4a")
        try Data([1]).write(to: url)
        defer { try? FileManager.default.removeItem(at: url); defaults.removePersistentDomain(forName: suite) }
        defaults.set(url.path, forKey: "native.voice.pending"); defaults.set("owner", forKey: "native.voice.owner")
        let voice = VoiceRecorder(defaults: defaults), model = AppModel.testing(relay: SpeechFixtureRelay(), voice: voice)
        let chat = model.chat(for: AgentTask(.object(["id": .string("owner")])))
        chat.draft = "Keep draft"; chat.voiceInputOpen = true
        model.chats.removeValue(forKey: "owner")
        XCTAssertNil(model.finishVoiceInput("Transcript", ownerID: "owner", chat: chat))
        XCTAssertEqual(voice.pendingURL, url); XCTAssertEqual(chat.draft, "Keep draft")
        model.chats["owner"] = ChatSession()
        XCTAssertNil(model.finishVoiceInput("Transcript", ownerID: "owner", chat: chat))
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        // The rightful current draft consumes the recording only after insertion.
        let current = model.chats["owner"]!
        XCTAssertNotNil(model.finishVoiceInput("Transcript", ownerID: "owner", chat: current))
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
        let task = AgentTask(.object(["id": .string("owner"), "workspace_id": .string("project")]))
        let chat = model.chat(for: task)
        chat.draft = "Fix parser"; chat.voiceInputOpen = true
        chat.voiceInsertion = VoiceDraftInsertion(original: chat.draft, selection: NSRange(location: 4, length: 6))
        voice.recording = true
        await model.speechAction(.finish)
        XCTAssertEqual(chat.draft, "Fix lexer")
        XCTAssertNil(chat.voiceInsertion); XCTAssertFalse(chat.voiceInputOpen)
        XCTAssertNil(voice.pendingURL); XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
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
