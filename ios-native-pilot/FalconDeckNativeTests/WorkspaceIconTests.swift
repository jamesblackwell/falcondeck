import XCTest
import UIKit
@testable import FalconDeckNative

@MainActor final class WorkspaceIconTests: XCTestCase {
    private var project: Project { Project(Demo.projects[0].raw.setting("icon", .object(["kind": .string("image"), "etag": .string("first")]))) }
    private func png() -> String {
        UIGraphicsImageRenderer(size: CGSize(width: 512, height: 512)).pngData { context in
            UIColor.systemMint.setFill(); context.fill(CGRect(x: 0, y: 0, width: 512, height: 512))
        }.base64EncodedString()
    }
    func testPinsAndProjectHeadingShareOneReadAndKeepADecodedThumbnailAcrossReconnects() async throws {
        let cache = WorkspaceIconCache(), relay = IconRelay(data: png(), held: true), connection = UUID()
        let first = Task { try await cache.load(project, connectionID: connection, relay: relay) }
        await relay.waitForCall()
        var joined = false
        let second = Task { joined = true; return try await cache.load(project, connectionID: connection, relay: relay) }
        while !joined { await Task.yield() }
        await relay.release()
        let loaded = try await first.value
        let image = try XCTUnwrap(loaded)
        let shared = try await second.value
        XCTAssertTrue(image === shared)
        XCTAssertLessThanOrEqual(max(image.size.width, image.size.height), 128)
        let reconnected = try await cache.load(project, connectionID: UUID(), relay: relay)
        XCTAssertTrue(image === reconnected)
        let calls = await relay.calls
        XCTAssertEqual(calls, 1)
    }
    func testChangedIconsAndPairingsDoNotReuseThePreviousImage() async throws {
        let cache = WorkspaceIconCache(), relay = IconRelay(data: png())
        _ = try await cache.load(project, connectionID: UUID(), relay: relay)
        let changed = Project(project.raw.setting("icon", project.raw["icon"].setting("etag", .string("changed"))))
        XCTAssertNil(cache.cached(changed))
        _ = try await cache.load(changed, connectionID: UUID(), relay: relay)
        cache.reset()
        XCTAssertNil(cache.cached(project)); XCTAssertNil(cache.cached(changed))
        _ = try await cache.load(project, connectionID: UUID(), relay: relay)
        let calls = await relay.calls
        XCTAssertEqual(calls, 3)
    }
    func testChangingPairingsRejectsLateSharedReads() async {
        let cache = WorkspaceIconCache(), relay = IconRelay(data: png(), held: true), connection = UUID()
        let first = Task { try await cache.load(project, connectionID: connection, relay: relay) }
        await relay.waitForCall()
        var joined = false
        let second = Task { joined = true; return try await cache.load(project, connectionID: connection, relay: relay) }
        while !joined { await Task.yield() }
        cache.reset(); await relay.release()
        for read in [first, second] {
            do { _ = try await read.value; XCTFail("A previous pairing's image must not reach a new one") }
            catch { XCTAssertTrue(error is CancellationError) }
        }
        XCTAssertNil(cache.cached(project))
    }
    func testInvalidImagesAreNotCachedAndCanBeRetried() async throws {
        let cache = WorkspaceIconCache(), relay = IconRelay(data: Data("Invalid image".utf8).base64EncodedString())
        for _ in 0..<2 {
            let image = try await cache.load(project, connectionID: UUID(), relay: relay)
            XCTAssertNil(image)
        }
        let calls = await relay.calls
        XCTAssertEqual(calls, 2)
    }
}

private actor IconRelay: RelayServing {
    private let data: String
    private let held: Bool
    private var readers: [CheckedContinuation<Void, Never>] = []
    private(set) var calls = 0
    init(data: String, held: Bool = false) { self.data = data; self.held = held }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async -> JSON {
        calls += 1
        if held { await withCheckedContinuation { readers.append($0) } }
        return .object(["kind": .string("image"), "data": .string(data)])
    }
    func waitForCall() async { while calls == 0 { await Task.yield() } }
    func release() { for reader in readers { reader.resume() }; readers = [] }
}
