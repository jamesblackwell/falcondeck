import XCTest
@testable import FalconDeckNative

@MainActor final class RealtimeTests: XCTestCase {
    func testPCMDecodingPreservesSignedStereoSamples() throws {
        let chunk = JSON.object(["sample_rate": .number(24000), "num_channels": .number(2), "samples_per_channel": .number(2), "data": .string(Data([0, 128, 255, 127, 0, 0, 0, 64]).base64EncodedString())])
        let decoded = try RealtimePCM.decode(chunk)
        XCTAssertEqual(decoded.frameLength, 2)
        XCTAssertEqual(decoded.format.channelCount, 2)
        let channels = try XCTUnwrap(decoded.floatChannelData)
        XCTAssertEqual(channels[0][0], -1, accuracy: 0.0001)
        XCTAssertEqual(channels[1][0], 0.999969, accuracy: 0.0001)
        XCTAssertEqual(channels[0][1], 0, accuracy: 0.0001)
        XCTAssertEqual(channels[1][1], 0.5, accuracy: 0.0001)
    }
    func testMalformedOrIncompletePCMDoesNotReachTheAudioEngine() {
        let valid = JSON.object(["sample_rate": .number(24000), "num_channels": .number(1), "data": .string(Data([0, 0]).base64EncodedString())])
        for bad in [valid.setting("num_channels", .number(0)), valid.setting("num_channels", .number(8)), valid.setting("sample_rate", .number(-1)), valid.setting("data", .string(Data([0]).base64EncodedString())), valid.setting("samples_per_channel", .number(2))] {
            XCTAssertThrowsError(try RealtimePCM.decode(bad))
        }
    }
    func testRealtimeSessionsAreBoundedAndInterruptedSessionsReleaseOwnership() {
        let audio = RealtimeAudio()
        for index in 0..<10 { audio.handle(.object(["type": .string("realtime-audio-started")]), taskID: "task-\(index)") }
        XCTAssertEqual(audio.active.count, 8)
        audio.handle(.object(["type": .string("realtime-audio-ended"), "interrupted": .bool(true)]), taskID: "task-9")
        XCTAssertFalse(audio.active.contains("task-9"))
        audio.stop(); XCTAssertTrue(audio.active.isEmpty)
    }
    func testRealtimeConversationItemsAreVisibleInTheTranscript() {
        var transcript = Transcript()
        transcript.apply(.object(["type": .string("realtime-item-added"), "item": .object(["id": .string("realtime"), "title": .string("Audio response"), "payload": .object(["text": .string("Hello")])])]))
        XCTAssertEqual(transcript.items.first?.kind, "realtime")
        XCTAssertEqual(transcript.items.first?.raw["payload"]["text"].string, "Hello")
    }
    func testFastOffUsesTheSharedDefaultTierAndUnsupportedModelsOmitIt() {
        let task = AgentTask(.object(["id": .string("task"), "agent": .object(["service_tier": .string("priority")])]))
        let model = AgentModel(raw: .object(["id": .string("model"), "service_tiers": .array([.object(["id": .string("priority"), "label": .string("Fast")])])]))
        XCTAssertEqual(NativeRequest.turnSettings(["service_tier": .string("default")], task: task, model: model)["service_tier"], .string("default"))
        XCTAssertEqual(NativeRequest.turnSettings([:], task: task, model: model)["service_tier"], .string("priority"))
        XCTAssertEqual(NativeRequest.turnSettings(["service_tier": .string("standard")], task: task, model: model)["service_tier"], .string("default"))
        XCTAssertNil(NativeRequest.turnSettings(["service_tier": .string("priority")], task: task, model: nil)["service_tier"])
    }
}
