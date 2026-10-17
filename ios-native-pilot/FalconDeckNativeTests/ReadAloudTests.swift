import AVFoundation
import XCTest
@testable import FalconDeckNative

@MainActor final class ReadAloudTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let suite = "NativeReadAloudTests-\(UUID())"
        addTeardownBlock { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        let defaults = UserDefaults(suiteName: suite)!; defaults.set("desktop", forKey: "native.readAloud.provider")
        return defaults
    }
    func testLaterChunkFailureStaysAttachedToItsResponse() async throws {
        let relay = ReadAloudRelay(), model = AppModel.testing(relay: relay); model.connected = true
        let player = SilentTestPlayer()
        let speech = ReadAloud(defaults: defaults(), makePlayer: { _ in player })
        await speech.play(String(repeating: "a", count: 4001), id: "answer", model: model)
        XCTAssertEqual(speech.messageID, "answer")
        await speech.playbackFinished(id: ObjectIdentifier(player), successfully: true)
        XCTAssertEqual(speech.error, "Synthesis unavailable")
        XCTAssertEqual(speech.errorMessageID, "answer", "The transcript row only displays errors belonging to this response")
        XCTAssertNil(speech.messageID)
    }
    func testPauseWhileFetchingCannotReplayThePreviousChunk() async throws {
        let relay = ReadAloudRelay(blockedCall: 2), model = AppModel.testing(relay: relay); model.connected = true
        var players: [SilentTestPlayer] = []
        let speech = ReadAloud(defaults: defaults(), makePlayer: { _ in let player = SilentTestPlayer(); players.append(player); return player })
        await speech.play(String(repeating: "a", count: 4001), id: "answer", model: model)
        let advance = Task { await speech.playbackFinished(id: ObjectIdentifier(players[0]), successfully: true) }
        await relay.waitForRequest()
        speech.togglePause(); speech.togglePause()
        XCTAssertEqual(players[0].plays, 1, "Resume while loading must not restart audio which already finished")
        speech.togglePause()
        await relay.completeRequest()
        await advance.value
        XCTAssertEqual(players.count, 2)
        XCTAssertEqual(players.last?.plays, 0, "A paused chunk must not briefly play before being paused")
        speech.togglePause(); XCTAssertEqual(players.last?.plays, 1)
        speech.stop()
    }
    func testStoppingPendingSynthesisRejectsItsLateAudio() async {
        let relay = ReadAloudRelay(blockedCall: 1), model = AppModel.testing(relay: relay); model.connected = true
        var playerCount = 0
        let speech = ReadAloud(defaults: defaults(), makePlayer: { _ in playerCount += 1; return SilentTestPlayer() })
        let play = Task { await speech.play("Hello", id: "answer", model: model) }
        await relay.waitForRequest(); speech.stop(); await relay.completeRequest(); await play.value
        XCTAssertEqual(playerCount, 0); XCTAssertNil(speech.messageID); XCTAssertNil(speech.error)
    }
    func testReconnectKeepsPlaybackButForgetEndsIt() async {
        let model = AppModel.testing(relay: ReadAloudRelay()); model.hasSession = true
        model.readAloud.messageID = "answer"
        await model.reconnect()
        XCTAssertEqual(model.readAloud.messageID, "answer")
        await model.forget()
        XCTAssertNil(model.readAloud.messageID)
    }
    func testReadAloudCannotTakeTheAudioSessionFromARecording() async {
        let relay = ReadAloudRelay(), model = AppModel.testing(relay: relay)
        model.voice.recording = true
        let speech = ReadAloud(defaults: defaults(), makePlayer: { _ in SilentTestPlayer() })
        await speech.play("Hello", id: "answer", model: model)
        let calls = await relay.calls
        XCTAssertEqual(calls, 0)
        XCTAssertNil(speech.messageID)
        XCTAssertEqual(speech.errorMessageID, "answer")
        model.voice.finishRecording(); speech.stop()
    }
}

@MainActor private final class SilentTestPlayer: ReadAloudPlayback {
    var plays = 0
    func play() -> Bool { plays += 1; return true }
    func pause() { }
    func stop() { }
}

private actor ReadAloudRelay: RelayServing {
    var calls = 0
    let blockedCall: Int?
    private var pending: CheckedContinuation<JSON, Error>?
    private var ready: CheckedContinuation<Void, Never>?
    init(blockedCall: Int? = nil) { self.blockedCall = blockedCall }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async throws -> JSON {
        calls += 1
        if calls == blockedCall {
            return try await withCheckedThrowingContinuation { pending = $0; ready?.resume(); ready = nil }
        }
        if calls > 1 { throw PilotError("Synthesis unavailable") }
        return Self.audio
    }
    private static let audio = JSON.object(["audio_base64": .string(Data([1, 2]).base64EncodedString())])
    func waitForRequest() async {
        if pending != nil { return }
        await withCheckedContinuation { ready = $0 }
    }
    func completeRequest() { pending?.resume(returning: Self.audio); pending = nil }
}
