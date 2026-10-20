import XCTest
@testable import FalconDeckMac

final class NativeAudioPlaybackLifecycleTests: XCTestCase {
    @MainActor func testEndedRealtimeSessionRejectsChunksUntilAnotherStart() {
        for interrupted in [false, true] {
            let playback = NativeAudioPlayback()
            defer { playback.stopRealtime() }
            playback.handleRealtime(.object(["type": .string("realtime-audio-started")]), taskID: "task")
            playback.handleRealtime(.object([
                "type": .string("realtime-audio-ended"), "interrupted": .bool(interrupted)
            ]), taskID: "task")

            // Malformed input proves whether the delta reaches decoding without starting an audio engine.
            let delta: JSON = .object(["type": .string("realtime-audio-delta"), "audio": .object([:])])
            playback.handleRealtime(delta, taskID: "task")
            XCTAssertNil(playback.error)

            playback.handleRealtime(.object(["type": .string("realtime-audio-started")]), taskID: "task")
            playback.handleRealtime(delta, taskID: "task")
            XCTAssertEqual(playback.error, "Unsupported realtime audio format.")
        }
    }

    @MainActor func testEndingAnotherTaskDoesNotSilenceCurrentRealtimeSession() {
        let playback = NativeAudioPlayback()
        defer { playback.stopRealtime() }
        playback.handleRealtime(.object(["type": .string("realtime-audio-started")]), taskID: "current")
        playback.handleRealtime(.object([
            "type": .string("realtime-audio-ended"), "interrupted": .bool(true)
        ]), taskID: "other")

        playback.handleRealtime(.object([
            "type": .string("realtime-audio-delta"), "audio": .object([:])
        ]), taskID: "current")
        XCTAssertEqual(playback.error, "Unsupported realtime audio format.")
    }
}
