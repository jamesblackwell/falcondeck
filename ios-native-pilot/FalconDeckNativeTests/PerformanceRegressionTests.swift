import Foundation
import XCTest
import os
@testable import FalconDeckNative

@MainActor final class PerformanceRegressionTests: XCTestCase {
    func testFastJSONDecoderPreservesWireTypesAndRejectsInvalidInput() throws {
        for source in [#"{"a":true,"b":false,"n":1,"z":0,"negative":-2.5,"null":null,"items":["👩🏽‍💻",{},[1e3]]}"#, "true", "1", "-0.5", "null", #""hello\nworld""#] {
            let data = Data(source.utf8)
            XCTAssertEqual(try JSON.decode(data), try JSONDecoder().decode(JSON.self, from: data))
        }
        for source in ["{", "NaN", "[1,]garbage", "1e9999"] { XCTAssertThrowsError(try JSON.decode(Data(source.utf8))) }
    }
    func testMessageProjectionTracksTextAndKind() {
        var message = Message(.object(["id": .string("user"), "kind": .string("user_message"), "text": .string("<user_query>Original</user_query>")]))
        XCTAssertEqual(message.userProjection?.result, .prompt("Original", automated: false))
        let cached = message.userProjection
        message.raw = message.raw.setting("lifecycle", .string("complete"))
        XCTAssertEqual(message.userProjection, cached)
        message.raw = message.raw.setting("text", .string("<user_query>Changed</user_query>"))
        XCTAssertEqual(UserTextProjection.messages([message]).first?.text, "Changed")
        message.raw = message.raw.setting("kind", .string("assistant_message"))
        XCTAssertNil(message.userProjection)
        XCTAssertEqual(UserTextProjection.messages([message]).first?.text, "<user_query>Changed</user_query>")
    }
    func testPresentationInvalidatesOnEditsReplacementPreferencesAndRunningState() {
        let chat = ChatSession(), preferences = ConversationPreferences(raw: .null)
        let reasoning = Message(.object(["id": .string("r"), "kind": .string("reasoning"), "content": .string("Thinking locally"), "lifecycle": .string("streaming")]))
        chat.transcript = Transcript(items: [reasoning])
        XCTAssertTrue(chat.presentation(preferences: preferences, running: true).blocks[0].items[0].streaming)
        XCTAssertFalse(chat.presentation(preferences: preferences, running: false).blocks[0].items[0].streaming)
        chat.transcript = Transcript(items: [Message(.object(["id": .string("a"), "kind": .string("assistant_message"), "text": .string("Fresh detail")]))])
        XCTAssertEqual(chat.presentation(preferences: preferences, running: false).blocks.first?.items.first?.text, "Fresh detail")
        chat.transcript.items[0].raw = chat.transcript.items[0].raw.setting("text", .string("Edited"))
        XCTAssertEqual(chat.presentation(preferences: preferences, running: false).blocks.first?.items.first?.text, "Edited")
        chat.transcript.items = [Message(.object(["id": .string("tool"), "kind": .string("tool_call"), "status": .string("complete")]))]
        XCTAssertTrue(chat.presentation(preferences: preferences, running: false).blocks[0].grouped)
        XCTAssertFalse(chat.presentation(preferences: ConversationPreferences(raw: .object(["tool_details_mode": .string("expanded")])), running: false).blocks[0].grouped)
    }
    func testTranscriptIndexAndUTF16CacheSurviveReplacementsPrependAndReplay() {
        func item(_ id: String, _ text: String) -> Message { Message(.object(["id": .string(id), "kind": .string("assistant_message"), "text": .string(text)])) }
        func delta(_ id: String, _ text: String, _ start: Int) -> JSON { .object(["type": .string("text"), "item_id": .string(id), "delta": .string(text), "start_offset": .number(Double(start)), "end_offset": .number(Double(start + text.utf16.count))]) }
        var transcript = Transcript(items: [item("a", "👋")])
        transcript.apply(delta("a", " there", 2))
        transcript.apply(delta("a", " there", 2)) // replay
        XCTAssertEqual(transcript.items[0].text, "👋 there")
        transcript.prepend([item("older", "Earlier")])
        transcript.apply(delta("a", "!", 8))
        XCTAssertEqual(transcript.items[1].text, "👋 there!")
        transcript.items = [item("a", "New")]
        transcript.apply(delta("a", " text", 3))
        XCTAssertEqual(transcript.items[0].text, "New text")
        transcript.upsert(item("a", "Longer authoritative detail"))
        transcript.apply(delta("a", "!", "Longer authoritative detail".utf16.count))
        XCTAssertFalse(transcript.needsRecovery)
        XCTAssertEqual(transcript.items[0].text, "Longer authoritative detail!")
        transcript.apply(delta("a", "wrong", 1))
        XCTAssertTrue(transcript.needsRecovery)
    }
    func testCompactEndpointAndRefreshCoalescing() throws {
        let url = try NativeRelayEndpoint.updates(relay: URL(string: "https://connect.falcondeck.com")!, sessionID: "a/b +&", ticket: "ticket/+=&")
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let query = Dictionary(components.queryItems!.map { ($0.name, $0.value!) }, uniquingKeysWith: { first, _ in first })
        XCTAssertEqual(components.scheme, "wss")
        XCTAssertEqual(query["compact_index"], "true"); XCTAssertEqual(query["transport"], "chunks-v1")
        XCTAssertEqual(query["session_id"], "a/b +&"); XCTAssertEqual(query["ticket"], "ticket/+=&")
        var refresh = RelayRefreshSchedule()
        let now = Date()
        XCTAssertEqual(refresh.request(now: now, urgent: true), .zero)
        refresh.began(now: now); XCTAssertFalse(refresh.dirty)
        XCTAssertEqual(refresh.request(now: now.addingTimeInterval(1)), .seconds(9))
        XCTAssertTrue(refresh.dirty, "An invalidation during a refresh must trigger a trailing refresh")
        XCTAssertEqual(refresh.request(now: now.addingTimeInterval(20)), .seconds(1))
        refresh.began(now: now.addingTimeInterval(21)); XCTAssertFalse(refresh.dirty)
    }
    func testStartupLoadsSessionOnceAndKeepsMainActorResponsive() async {
        let calls = OSAllocatedUnfairLock(initialState: 0)
        let host = AppModel.testing(relay: UnavailablePreviewRelay(), sessionLoader: {
            calls.withLock { $0 += 1 }; Thread.sleep(forTimeInterval: 0.15); return nil
        })
        let start = Task { await host.start() }
        try? await Task.sleep(for: .milliseconds(40))
        XCTAssertTrue(host.restoringSession, "The UI actor must run while Keychain is loading")
        await start.value
        XCTAssertEqual(calls.withLock { $0 }, 1)
        XCTAssertFalse(host.restoringSession)
    }
}

final class RelayUploadTests: XCTestCase {
    func testWindowFillsBeforeAcknowledgementAndReassemblesInOrder() async throws {
        let upload = RelayUpload(), probe = UploadProbe()
        let bytes = Data((0..<(RelayUpload.chunkBytes * 40 + 5)).map { UInt8($0 % 251) })
        let send = Task {
            try await upload.send(bytes, id: 42) { frame in try await probe.receive(frame) }
        }
        await probe.waitForCount(16)
        let initial = await probe.count
        XCTAssertEqual(initial, 16)
        // Wrong/old/unsent ACKs cannot create send credit.
        await upload.acknowledge(99); await upload.acknowledge(-1)
        for index in 0..<41 {
            await probe.waitForCount(min(41, index + 16))
            await upload.acknowledge(index)
            await upload.acknowledge(index)
        }
        try await send.value
        let result = await probe.result, count = await probe.count
        XCTAssertEqual(result, bytes)
        XCTAssertEqual(count, 41)
    }
    func testMissingACKTimesOutAndCancelReleasesWaitingSender() async throws {
        let upload = RelayUpload(progressTimeout: .milliseconds(30))
        do { try await upload.send(Data(repeating: 1, count: 12_000), id: 1) { _ in }; XCTFail("Missing ACK must time out") }
        catch { XCTAssertTrue(error.localizedDescription.contains("acknowledge")) }
        let cancelled = RelayUpload(), probe = UploadProbe()
        let task = Task { try await cancelled.send(Data(repeating: 2, count: 12_000), id: 2) { frame in try await probe.receive(frame) } }
        await probe.waitForCount(2)
        await cancelled.cancel()
        do { try await task.value; XCTFail("Disconnect must release the upload") } catch is CancellationError { }
        await cancelled.acknowledge(0) // Late ACK is harmless.
    }
    func testWriterFailureStopsTheTransfer() async {
        let upload = RelayUpload()
        do { try await upload.send(Data(repeating: 1, count: 12_000), id: 1) { _ in throw PilotError("Write failed") }; XCTFail() }
        catch { XCTAssertEqual(error.localizedDescription, "Write failed") }
    }
    func testFastAcknowledgementsCannotBeLostBeforeTheWaiterIsInstalled() async throws {
        let upload = RelayUpload(progressTimeout: .milliseconds(50))
        try await upload.send(Data(repeating: 1, count: 40_000), id: 1) { frame in
            await upload.acknowledge(frame["index"].int)
        }
    }
    func testTaskCancellationReleasesTheProgressWaiter() async throws {
        let upload = RelayUpload(), probe = UploadProbe()
        let task = Task { try await upload.send(Data(repeating: 2, count: 12_000), id: 2) { frame in try await probe.receive(frame) } }
        await probe.waitForCount(2)
        task.cancel()
        do { try await task.value; XCTFail("Cancelled tasks must release the upload") } catch is CancellationError { }
    }
}

private actor UploadProbe {
    var count = 0
    var result: Data?
    private var receiver = ChunkReceiver()
    func receive(_ frame: JSON) throws { result = try receiver.receive(frame) ?? result; count += 1 }
    func waitForCount(_ target: Int) async {
        for _ in 0..<1000 {
            if count >= target { return }
            try? await Task.sleep(for: .milliseconds(1))
        }
    }
}
