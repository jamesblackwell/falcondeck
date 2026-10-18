import XCTest
import UIKit
@testable import FalconDeckNative

@MainActor final class ImageRecoveryTests: XCTestCase {
    private func session(_ device: String = "fixture", secret: UInt8 = 1) -> SavedSession {
        SavedSession(relay: URL(string: "https://image-cache.test")!, sessionID: "fixture", deviceID: device, token: "fixture", secret: Data(repeating: secret, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
    }
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "ImageCacheTest-\(UUID())")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }; return url
    }
    private func png(_ color: UIColor = .systemGreen) -> Data {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 2500, height: 8), format: format).pngData { context in
            color.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2500, height: 8))
        }
    }
    private func resource(_ item: String = "item", url: String = "", attachment: String = "a") -> MediaImageResource {
        MediaImageResource(reference: .object(["id": .string(attachment), "url": .string(url), "local_path": .string("/host/image.png")]),
            task: AgentTask(.object(["id": .string("task"), "workspace_id": .string("project")])), itemID: item)
    }
    func testImageWaitsForRelayAndRetainsOriginalBytesThroughOfflineRelaunch() async throws {
        let original = png(), relay = ImageRecoveryRelay(image: png()), root = try root()
        let model = AppModel.testing(relay: relay)
        model.sessionCache = try SessionCacheStore(session: session(), root: root)
        let display = ImageDisplay()
        await display.load(resource(), model: model)
        XCTAssertNil(display.image); XCTAssertNil(display.error)
        let before = await relay.requests; XCTAssertEqual(before, 0)
        model.connected = true
        await display.load(resource(), model: model)
        XCTAssertNotNil(display.image); XCTAssertEqual(display.bytes, original)
        XCTAssertEqual(try XCTUnwrap(UIImage(data: XCTUnwrap(display.bytes))).size.width, 2500)
        let connection = model.connectionID
        model.hasSession = true; await model.reconnect()
        XCTAssertNotEqual(model.connectionID, connection)
        let recycled = ImageDisplay(); await recycled.load(resource(), model: model)
        XCTAssertNotNil(recycled.image)
        let restored = AppModel.testing(relay: relay)
        restored.sessionCache = try SessionCacheStore(session: session(), root: root)
        let relaunched = ImageDisplay(); await relaunched.load(resource(), model: restored)
        XCTAssertNotNil(relaunched.image); XCTAssertEqual(relaunched.bytes, original)
        let count = await relay.requests; XCTAssertEqual(count, 1)
    }
    func testChangedInlineImageReplacesCachedBytesForTheSameItem() async throws {
        let model = AppModel.testing(relay: ImageRecoveryRelay(image: png()))
        model.sessionCache = try SessionCacheStore(session: session(), root: root())
        let first = png(), second = png(.systemBlue), display = ImageDisplay()
        await display.load(resource(url: "data:image/png;base64," + first.base64EncodedString()), model: model)
        await display.load(resource(url: "data:image/png;base64," + second.base64EncodedString()), model: model)
        XCTAssertEqual(display.bytes, second)
    }
    func testAnAlreadyDisplayedImageIsSavedWhenItsCacheBecomesAvailable() async throws {
        let root = try root(), original = png(), relay = ImageRecoveryRelay(image: png())
        let model = AppModel.testing(relay: relay), display = ImageDisplay()
        let inline = resource(url: "data:image/png;base64," + original.base64EncodedString())
        await display.load(inline, model: model)
        XCTAssertNotNil(display.image)
        model.sessionCache = try SessionCacheStore(session: session(), root: root)
        await display.load(inline, model: model)
        let restored = AppModel.testing(relay: relay)
        restored.sessionCache = try SessionCacheStore(session: session(), root: root)
        let reopened = ImageDisplay(); await reopened.load(resource(), model: restored)
        XCTAssertNotNil(reopened.image); XCTAssertEqual(reopened.bytes, original)
        let count = await relay.requests; XCTAssertEqual(count, 0)
    }
    func testOldAsyncImageCannotOverwriteANewerImage() async throws {
        let original = png(), relay = ImageRecoveryRelay(image: png())
        let model = AppModel.testing(relay: relay); model.connected = true
        let display = ImageDisplay()
        let old = Task { await display.load(resource("slow"), model: model) }
        await relay.waitForSlowRequest()
        let current = png(.systemBlue)
        await display.load(resource("new", url: "data:image/png;base64," + current.base64EncodedString()), model: model)
        await relay.releaseSlow(); await old.value
        XCTAssertNotEqual(original, current); XCTAssertEqual(display.bytes, current)
    }
    func testForgetRejectsAnImageAlreadyInFlight() async {
        let relay = ImageRecoveryRelay(image: png()), display = ImageDisplay()
        let model = AppModel.testing(relay: relay); model.connected = true
        let load = Task { await display.load(resource("slow"), model: model) }
        await relay.waitForSlowRequest()
        await model.forget(); await relay.releaseSlow(); await load.value
        XCTAssertNil(display.image); XCTAssertNil(display.bytes)
    }
    func testCorruptDiskImageIsRefetchedWithoutBreakingTheConversation() async throws {
        let root = try root(), original = png(), relay = ImageRecoveryRelay(image: png())
        let model = AppModel.testing(relay: relay); model.connected = true
        model.sessionCache = try SessionCacheStore(session: session(), root: root)
        await ImageDisplay().load(resource(), model: model)
        let file = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.allObjects.compactMap { $0 as? URL }.first { $0.deletingLastPathComponent().lastPathComponent == "images" })
        try Data("broken cache file".utf8).write(to: file)
        let restored = AppModel.testing(relay: relay); restored.connected = true
        restored.sessionCache = try SessionCacheStore(session: session(), root: root)
        let display = ImageDisplay(); await display.load(resource(), model: restored)
        XCTAssertEqual(display.bytes, original); XCTAssertNotNil(display.image); XCTAssertNil(display.error)
        let count = await relay.requests; XCTAssertEqual(count, 2)
    }
    func testBackgroundLoadPreservesTheImageWithoutRefetching() async throws {
        let relay = ImageRecoveryRelay(image: png())
        let model = AppModel.testing(relay: relay)
        let display = ImageDisplay(), request = resource(url: "data:image/png;base64," + png().base64EncodedString())
        await display.load(request, model: model)
        let bytes = display.bytes
        await display.load(request, model: model, foreground: false)
        await display.load(request, model: model)
        XCTAssertEqual(display.bytes, bytes); XCTAssertNotNil(display.image); XCTAssertFalse(display.loading)
        let calls = await relay.requests; XCTAssertEqual(calls, 0)
    }
    func testImageIdentityMatchesHydratedHistoryAndSeparatesAttachmentsAndSources() {
        XCTAssertEqual(resource().cacheIdentity, resource(url: "data:image/png;base64,AAAA").cacheIdentity)
        XCTAssertNotEqual(resource().cacheIdentity, resource(attachment: "b").cacheIdentity)
        XCTAssertNotEqual(resource().cacheIdentity, resource("other").cacheIdentity)
        XCTAssertNotEqual(resource(url: "https://image.test/1").cacheIdentity, resource(url: "https://image.test/2").cacheIdentity)
        let item: JSON = .object(["attachments": .array([.object(["url": .string("wrong"), "id": .string("wrong")]), .object(["url": .string("right"), "id": .string("a")])])])
        XCTAssertEqual(resource().source(in: item), "right")
        XCTAssertEqual(resource(attachment: "missing").source(in: item), "")
    }
    func testImageCacheIsEncryptedBoundedIsolatedAndClearedOnForget() async throws {
        let root = try root(), store = try SessionCacheStore(session: session(), root: root, imageDiskBudget: 2500)
        let image = CachedImage(original: Data(repeating: 1, count: 600), thumbnail: Data(repeating: 2, count: 100))
        for index in 0..<5 { try await store.saveImage(image, identity: ["image", String(index)]) }
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey])!.allObjects.compactMap { $0 as? URL }.filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
        let bytes = try files.reduce(0) { try $0 + $1.resourceValues(forKeys: [.fileSizeKey]).fileSize! }
        XCTAssertLessThanOrEqual(bytes, 2500)
        let fresh = try SessionCacheStore(session: session(), root: root)
        let last = await fresh.loadImage(["image", "4"]); XCTAssertEqual(last?.original, image.original)
        let first = await fresh.loadImage(["image", "0"]); XCTAssertNil(first)
        let other = try SessionCacheStore(session: session("other"), root: root)
        let isolated = await other.loadImage(["image", "4"]); XCTAssertNil(isolated)
        let wrong = try SessionCacheStore(session: session(secret: 2), root: root)
        let unauthenticated = await wrong.loadImage(["image", "4"]); XCTAssertNil(unauthenticated)
        try await store.clear(); try await store.saveImage(image, identity: ["late"])
        let cleared = await store.loadImage(["image", "4"]); XCTAssertNil(cleared)
        let late = await store.loadImage(["late"]); XCTAssertNil(late)
    }
}

private actor ImageRecoveryRelay: RelayServing {
    let image: Data
    private(set) var requests = 0
    private var slow: CheckedContinuation<Void, Never>?
    private var started: CheckedContinuation<Void, Never>?
    private var slowStarted = false
    init(image: Data) { self.image = image }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func waitForSlowRequest() async { if !slowStarted { await withCheckedContinuation { started = $0 } } }
    func releaseSlow() { slow?.resume(); slow = nil }
    func call(_ method: String, params: JSON) async -> JSON {
        requests += 1
        if params["item_id"].string == "slow" {
            await withCheckedContinuation { continuation in slow = continuation; slowStarted = true; started?.resume(); started = nil }
        }
        return .object(["id": params["item_id"], "kind": .string("image"), "image": .object(["url": .string("data:image/png;base64," + image.base64EncodedString())])])
    }
}
