import UIKit
import AVFoundation
import CoreTransferable
import UniformTypeIdentifiers
import XCTest
@testable import FalconDeckNative

@MainActor final class MediaTests: XCTestCase {
    func testInProgressToolOutputIsFetchedAgainUntilItIsFinal() async throws {
        let relay = ItemSnapshotRelay(), model = AppModel.testing(relay: relay)
        let task = AgentTask(.object(["id": .string("task"), "workspace_id": .string("project")]))
        let partial = try await model.fullItem(task, itemID: "tool")
        XCTAssertEqual(partial["output"].string, "Partial output")
        let final = try await model.fullItem(task, itemID: "tool")
        XCTAssertEqual(final["output"].string, "Complete output")
        let cached = try await model.fullItem(task, itemID: "tool")
        XCTAssertEqual(cached, final)
        let count = await relay.requests
        XCTAssertEqual(count, 2)
    }
    func testImageSharingNegotiatesTheConcreteFormatWithoutReencoding() async throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            UIColor.systemGreen.setFill(); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        for (bytes, type, wrongType) in [(try XCTUnwrap(image.pngData()), UTType.png, UTType.jpeg), (try XCTUnwrap(image.jpegData(compressionQuality: 0.9)), UTType.jpeg, UTType.png)] {
            let provider = NSItemProvider(); provider.register(ExportedImage(data: bytes, title: "Original"))
            XCTAssertTrue(provider.hasItemConformingToTypeIdentifier(type.identifier))
            XCTAssertFalse(provider.hasItemConformingToTypeIdentifier(wrongType.identifier))
            let received: Data = try await withCheckedThrowingContinuation { continuation in
                _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                    if let error { continuation.resume(throwing: error); return }
                    do { continuation.resume(returning: try Data(contentsOf: XCTUnwrap(url))) }
                    catch { continuation.resume(throwing: error) }
                }
            }
            XCTAssertEqual(received, bytes)
        }
    }

    func testImageSharingRetainsOriginalBytesAndResolution() throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 2500, height: 8), format: format)
        let original = renderer.pngData { context in UIColor.systemGreen.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2500, height: 8)) }
        let preview = try NativeAttachment.prepare(original)
        XCTAssertLessThan(try XCTUnwrap(UIImage(data: preview.data)).size.width, 2500)
        let url = try ExportedImage(data: original, title: "../../Original 🦅").fileURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let shared = try Data(contentsOf: url)
        XCTAssertEqual(shared, original)
        XCTAssertEqual(try XCTUnwrap(UIImage(data: shared)).size.width, 2500)
        XCTAssertEqual(url.pathExtension, "png")
        XCTAssertFalse(url.lastPathComponent.contains("/"))
        XCTAssertThrowsError(try ExportedImage(data: Data("invalid".utf8), title: "Invalid").fileURL())
    }

    func testAttachmentPreparationAndImageOnlyWireInput() throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        let data = renderer.pngData { context in UIColor.systemGreen.setFill(); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8)) }
        let attachment = try NativeAttachment.prepare(data, name: "Test.png")
        XCTAssertNotNil(UIImage(data: attachment.data))
        XCTAssertTrue(attachment.input["url"].string.hasPrefix("data:image/"))
        XCTAssertEqual(attachment.input["local_path"], .null)
        let task = AgentTask(.object(["id": .string("t"), "workspace_id": .string("w"), "provider": .string("codex")]))
        let request = NativeRequest.turn(task: task, text: "", itemID: "user-image", modelID: "", effort: "", attachments: [attachment])
        XCTAssertEqual(request["inputs"].array.count, 1)
        XCTAssertEqual(request["inputs"].array[0]["type"].string, "image")
        XCTAssertEqual(request["approval_policy"], .null)
    }

    func testAttachmentBudgetsRejectOversizedAndInvalidImages() {
        XCTAssertThrowsError(try NativeAttachment.prepare(Data("not an image".utf8)))
        let image = NativeAttachment(id: "a", name: "Test", mimeType: "image/png", data: Data(repeating: 0, count: 8_000_000))
        XCTAssertNoThrow(try NativeAttachment.validate([image]))
        XCTAssertThrowsError(try NativeAttachment.validate([image, image]))
        XCTAssertThrowsError(try NativeAttachment.validate([NativeAttachment(id: "b", name: "Empty", mimeType: "image/png", data: Data())]))
    }

    func testIdenticalQueuedSendsClaimDifferentServerRows() {
        let first = QueuedDraft(id: "first", text: "Hello", attachmentCount: 0, knownIDs: [])
        let second = QueuedDraft(id: "second", text: "Hello", attachmentCount: 0, knownIDs: [])
        func queued(_ id: String) -> JSON { .object(["id": .string(id), "text": .string("Hello"), "attachment_count": .number(0)]) }
        let oneEcho = QueuedDraft.reconcile([first, second], queued: [queued("server-1")], items: [])
        XCTAssertEqual(oneEcho.map(\.id), ["second"])
        XCTAssertTrue(oneEcho[0].knownIDs.contains("server-1"))
        XCTAssertEqual(QueuedDraft.reconcile(oneEcho, queued: [queued("server-1")], items: []).map(\.id), ["second"])
        XCTAssertTrue(QueuedDraft.reconcile(oneEcho, queued: [queued("server-1"), queued("server-2")], items: []).isEmpty)
    }

    func testQueuedEchoAndSafeMediaSchemes() {
        let pending = QueuedDraft(id: "user-echo", text: "Hello", attachmentCount: 0, knownIDs: [])
        let echo = Message(.object(["id": .string("user-echo"), "kind": .string("user_message"), "text": .string("Hello")]))
        XCTAssertTrue(QueuedDraft.reconcile([pending], queued: [], items: [echo]).isEmpty)
        XCTAssertNotNil(MediaURL.external("https://example.com/image.png"))
        XCTAssertNil(MediaURL.external("javascript:alert(1)"))
        XCTAssertNil(MediaURL.external("file:///private/image.png"))
        XCTAssertNil(MediaURL.external("https://user:password@example.com/image.png"))
        XCTAssertNil(MediaURL.data("data:text/html;base64,SGVsbG8="))
        XCTAssertEqual(MediaURL.data("data:image/png;base64,SGVsbG8="), Data("Hello".utf8))
    }

    func testConversationExportIncludesToolsAndLabelsPartialHistory() {
        let tool = Message(.object(["id": .string("tool"), "kind": .string("tool_call"), "title": .string("Run tests"), "output": .string("```\npassed"), "display": .object(["output_total_bytes": .number(2000)])]))
        let markdown = TranscriptExport.markdown([tool], title: "Native", partial: true)
        XCTAssertTrue(markdown.contains("Partial export"))
        XCTAssertTrue(markdown.contains("Run tests"))
        XCTAssertTrue(markdown.contains("````text"))
        XCTAssertTrue(markdown.contains("Output preview"))
    }

    func testRemoteImageBudgetRejectsAnUnknownLengthStream() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ImageFixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let url = URL(string: "https://native-image.test/fixture")!
        do { _ = try await BoundedImageDownload.shared.download(url, session: session, maxBytes: 8); XCTFail("An oversized image must be rejected during streaming") }
        catch { XCTAssertTrue(error.localizedDescription.contains("limit")) }
        let valid = try await BoundedImageDownload.shared.download(url, session: session, maxBytes: 200)
        XCTAssertEqual(valid.count, 100)
    }

    func testRecordingInterruptionFinalizesListeningAndRetainsRecovery() {
        let suite = "NativeRecordingInterruptionTests-\(UUID())", defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let recorder = VoiceRecorder(defaults: defaults)
        let pending = recorder.pendingURL
        recorder.recording = true
        recorder.interrupted()
        XCTAssertFalse(recorder.recording)
        XCTAssertEqual(recorder.pendingURL, pending)
        XCTAssertTrue(recorder.error?.contains("interrupted") == true)
    }

    func testReadAloudChunksStayWithinDaemonLimitAndPreserveUnicode() {
        let text = String(repeating: "Hello 🦅 é. ", count: 1000)
        let chunks = ReadAloud.chunks(text)
        XCTAssertEqual(chunks.joined(), text)
        XCTAssertTrue(chunks.allSatisfy { $0.unicodeScalars.count <= 4000 })
        XCTAssertGreaterThan(chunks.count, 1)
    }

    func testReadAloudRemovesCodeAndMarkdownSyntax() {
        let spoken = ReadAloud.spokenText("# Welcome\n**Hello** [James](https://example.com).\n```swift\nlet x = 1\n```")
        XCTAssertTrue(spoken.contains("Hello James"))
        XCTAssertFalse(spoken.contains("https://"))
        XCTAssertFalse(spoken.contains("let x"))
    }
}

private actor ItemSnapshotRelay: RelayServing {
    private(set) var requests = 0
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) -> JSON {
        requests += 1
        return .object(["id": params["item_id"], "kind": .string("tool_call"), "status": .string(requests == 1 ? "in_progress" : "completed"), "output": .string(requests == 1 ? "Partial output" : "Complete output")])
    }
}

private final class ImageFixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "native-image.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "image/png"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(repeating: 1, count: 100))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
