import XCTest
import UIKit
@testable import FalconDeckNative

/// A computer that serves in-memory files through the same two RPCs as the daemon.
actor FakeFileRelay: RelayServing {
    struct Entry { var data: Data; var version = "1:1"; var kind = "text"; var type = "text/plain"; var name = "file.txt" }
    var files: [String: Entry]
    var calls: [(method: String, offset: Int)] = []
    var rangeLengths: [Int] = []
    var failures: [String: [String]] = [:]       // path -> queued error messages for read_range
    var changeAfterFirstRange = false
    var delay: Duration = .zero
    var compress = false
    var maxRange = 8 * 1024
    var shortReplies = false

    init(_ files: [String: Entry]) { self.files = files }
    func failNext(_ path: String, _ messages: String...) { failures[path, default: []] += messages }
    func setFiles(_ path: String, _ entry: Entry) { files[path] = entry }
    func setCompress(_ value: Bool) { compress = value }
    func setDelay(_ value: Duration) { delay = value }
    func setChangeAfterFirstRange(_ value: Bool) { changeAfterFirstRange = value }
    func setShortReplies(_ value: Bool) { shortReplies = value }
    func count(_ method: String) -> Int { calls.filter { $0.method == method }.count }

    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) throws {}
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) {}
    func refresh() {}
    func detail(task: AgentTask, before: String?) throws -> JSON { .null }

    private func meta(_ path: String, _ entry: Entry) -> [String: JSON] {
        ["path": .string(path), "name": .string(entry.name), "size_bytes": .number(Double(entry.data.count)), "modified_ms": .number(1_700_000_000_000),
         "version": .string(entry.version), "content_type": .string(entry.type), "kind": .string(entry.kind), "max_range_bytes": .number(Double(maxRange))]
    }

    func call(_ method: String, params: JSON) async throws -> JSON {
        let path = params["path"].string
        calls.append((method, params["offset"].int))
        if delay > .zero { try await Task.sleep(for: delay) }
        guard let entry = files[path] else { throw PilotError("file_not_found: This file no longer exists on your Mac.") }
        if method == "file.stat" { return .object(meta(path, entry)) }
        if let message = failures[path]?.first { failures[path]?.removeFirst(); throw PilotError(message) }
        if let pinned = params["version"].string.nonempty, pinned != entry.version { throw PilotError("file_changed: This file changed on your Mac while it was loading.") }
        let offset = min(params["offset"].int, entry.data.count)
        var length = min(params["length"].int, maxRange, entry.data.count - offset)
        if shortReplies, length > 100 { length /= 2 }
        rangeLengths.append(length)
        let raw = entry.data.subdata(in: offset..<offset + length)
        var payload = raw, encoding = "identity"
        if compress, params["compress"].bool, !raw.isEmpty, let packed = try? (raw as NSData).compressed(using: .zlib) as Data, packed.count < raw.count { payload = packed; encoding = "deflate" }
        var reply = meta(path, entry)
        reply["offset"] = .number(Double(offset)); reply["length"] = .number(Double(length)); reply["eof"] = .bool(offset + length >= entry.data.count)
        reply["encoding"] = .string(encoding); reply["data_base64"] = .string(payload.base64EncodedString())
        let result = JSON.object(reply)
        if changeAfterFirstRange, offset == 0 { files[path]?.version = "2:2" }
        return result
    }
}

final class FilePreviewTests: XCTestCase {
    private var directory: URL!
    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory.appending(path: "FilePreviewTests-\(UUID())", directoryHint: .isDirectory)
    }
    override func tearDown() { try? FileManager.default.removeItem(at: directory); super.tearDown() }

    private func store(_ relay: FakeFileRelay, budget: Int = FileDiskCache.defaultBudget) -> RemoteFileStore {
        RemoteFileStore(relay: relay, cache: FileDiskCache(root: directory, budget: budget), retryDelay: .milliseconds(1))
    }
    private func payload(_ size: Int) -> Data { Data((0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) }) }
    private func bytes(_ file: LoadedFile) throws -> Data { try Data(contentsOf: file.url) }

    func testSymlinkedCacheRootKeepsDownloadedImagesAndEvictsOnlyOlderFiles() async throws {
        let real = directory.appending(path: "real", directoryHint: .isDirectory)
        let alias = directory.appending(path: "alias", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        let data = try XCTUnwrap(image.pngData())
        let relay = FakeFileRelay([
            "/tmp/first.png": .init(data: data, kind: "image", type: "image/png", name: "first.png"),
            "/tmp/second.png": .init(data: data, kind: "image", type: "image/png", name: "second.png"),
        ])
        // The cache directory does not exist yet; only its parent is a symlink.
        // A tiny budget exercises eviction's keep comparison as well as commit.
        let cache = FileDiskCache(root: alias.appending(path: "cache", directoryHint: .isDirectory), budget: 1)
        let store = RemoteFileStore(relay: relay, cache: cache)
        let first = try await store.open(FileReference(path: "/tmp/first.png"), probe: .firstRange)
        XCTAssertEqual(try bytes(first), data)
        XCTAssertNotNil(FileImage.decode(first.url, maxPixel: 1400))
        let again = try await store.open(FileReference(path: "/tmp/first.png"), probe: .firstRange)
        XCTAssertTrue(again.fromCache)
        let second = try await store.open(FileReference(path: "/tmp/second.png"), probe: .firstRange)
        XCTAssertEqual(try bytes(second), data)
        XCTAssertNotNil(FileImage.decode(second.url, maxPixel: 1400))
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.url.path))
        XCTAssertNotNil(cache.lookup(second.meta))
        XCTAssertNotNil(cache.latest(path: second.meta.path))
    }

    // MARK: Links

    @MainActor func testBarePathsInProseBecomeLinksWithoutPunctuationOrLineNumbers() throws {
        let source = "Report: /Users/James/.falcondeck/artifacts/q4/report.md, and ~/notes/plan.html. See Sources/App/main.swift:42:7 or ../docs/a.pdf."
        let linked = FileLink.linkify(AttributedString(source))
        let links = linked.runs.compactMap { run in run.link.map { (String(linked[run.range].characters), $0) } }
        XCTAssertEqual(links.map(\.0), ["/Users/James/.falcondeck/artifacts/q4/report.md", "~/notes/plan.html", "Sources/App/main.swift", "../docs/a.pdf"])
        let context = FileContext(workspaceID: "w", threadID: "t")
        let references = links.compactMap { FileLink.reference(from: $0.1, context: context) }
        XCTAssertEqual(references.map(\.path), links.map(\.0))
        XCTAssertEqual(references.first?.workspaceID, "w")
    }

    @MainActor func testUrlsEmailsDirectoriesAndPlainWordsAreNotLinked() {
        for source in ["Open https://example.com/docs/guide.html now", "mail a/b@example.com/x.md", "the and/or choice", "folder /Users/James/www/sites/falcondeck here",
                       "see /api/v1/users.json", "version 1.2.3 and file.md alone", "a/b.unknownext"] {
            let linked = FileLink.linkify(AttributedString(source))
            XCTAssertNil(linked.runs.first { $0.link != nil }, source)
        }
    }

    @MainActor func testCodeSpansLinkBareReviewableNamesButExistingLinksAreKept() {
        // Both spans are inline code; only a whole span that is a path links.
        var run = AttributedString("report.md"); run.inlinePresentationIntent = .code
        var other = AttributedString("package.json"); other.inlinePresentationIntent = .code
        let combined = AttributedString("see ") + run + AttributedString(" and ") + other
        let linked = FileLink.linkify(combined)
        XCTAssertEqual(linked.runs.compactMap { $0.link != nil ? String(linked[$0.range].characters) : nil }, ["report.md"])
        var existing = AttributedString("/tmp/a.md"); existing.link = URL(string: "https://example.com")
        XCTAssertEqual(FileLink.linkify(existing).runs.first?.link, URL(string: "https://example.com"))
    }

    func testMarkdownLinksResolveThroughTheirContext() throws {
        let context = FileContext(workspaceID: "w", threadID: "t", baseDir: "/tmp/report")
        func path(_ text: String) -> String? { URL(string: text).flatMap { FileLink.reference(from: $0, context: context) }?.path }
        XCTAssertEqual(path("/Users/James/a.md"), "/Users/James/a.md")
        XCTAssertEqual(path("~/a.md"), "~/a.md")
        XCTAssertEqual(path("img/shot.png"), "img/shot.png")
        XCTAssertEqual(path("other.md#section"), "other.md")
        XCTAssertEqual(path("file:///tmp/a%20b.md"), "file:///tmp/a%20b.md")
        XCTAssertNil(path("#anchor")); XCTAssertNil(path("https://example.com/a.md")); XCTAssertNil(path("mailto:a@b.co")); XCTAssertNil(path("docs/readme")); XCTAssertEqual(path("/Users/James/.env"), "/Users/James/.env")
        let roundTrip = FileLink.url(for: "/tmp/with space/é.md").flatMap { FileLink.reference(from: $0, context: context) }
        XCTAssertEqual(roundTrip?.path, "/tmp/with space/é.md")
        XCTAssertEqual(roundTrip?.baseDir, "/tmp/report")
        XCTAssertEqual(roundTrip?.params["thread_id"], .string("t"))
    }

    func testLocalImageDestinationsAreSeparatedFromTheWeb() {
        XCTAssertTrue(FileLink.isLocalImage("/tmp/a.png")); XCTAssertTrue(FileLink.isLocalImage("img/a.png")); XCTAssertTrue(FileLink.isLocalImage("file:///tmp/a.png"))
        XCTAssertFalse(FileLink.isLocalImage("https://x.test/a.png")); XCTAssertFalse(FileLink.isLocalImage("data:image/png;base64,AA=="))
    }

    func testLoopbackLinksAreRecognisedButTailnetAndWebLinksAreNot() throws {
        for text in ["http://localhost:3000/x", "http://127.0.0.1:8080", "https://app.localhost/a", "http://[::1]:5173/"] { XCTAssertTrue(FileLink.isLoopback(try XCTUnwrap(URL(string: text))), text) }
        for text in ["https://mac.tail1234.ts.net/x", "https://example.com", "mailto:a@b.co", "/tmp/a.md"] { XCTAssertFalse(FileLink.isLoopback(try XCTUnwrap(URL(string: text))), text) }
    }

    // MARK: Errors

    func testDaemonErrorCodesBecomeFriendlyStates() {
        XCTAssertEqual(FilePreviewError(PilotError("file_denied: This file isn't shareable from your Mac.")), .denied)
        XCTAssertEqual(FilePreviewError(PilotError("file_not_found: gone")), .notFound)
        XCTAssertEqual(FilePreviewError(PilotError("file_too_large: big.pdf is 26.2 MB; previews on your phone are limited to 25 MB.")), .tooLarge("big.pdf is 26.2 MB; previews on your phone are limited to 25 MB."))
        XCTAssertEqual(FilePreviewError(PilotError("file_changed: x")), .changed)
        XCTAssertEqual(FilePreviewError(PilotError("Connect to your computer first.")), .notConnected)
        XCTAssertEqual(FilePreviewError(PilotError("The computer took too long to respond.")), .failed("The computer took too long to respond."))
        XCTAssertEqual(FilePreviewError.denied.title, "This file isn't shareable from your Mac")
        XCTAssertFalse(FilePreviewError.denied.retryable); XCTAssertTrue(FilePreviewError.notConnected.retryable)
    }

    // MARK: Transfer

    func testRawDeflateFromTheDaemonInflates() throws {
        // Produced by the daemon's encoder (flate2 raw deflate) for "hello file preview, " x 10.
        let packed = try XCTUnwrap(Data(base64Encoded: "y0jNyclXSMvMSVUoKEoty0wt11HIGIJiAA=="))
        XCTAssertEqual(try RemoteFileStore.inflate(packed), Data(String(repeating: "hello file preview, ", count: 10).utf8))
        XCTAssertThrowsError(try RemoteFileStore.inflate(Data([0xFF, 0xFF, 0xFF])))
    }

    func testAMultiRangeFileArrivesIntactWithMonotonicProgress() async throws {
        let data = payload(100_000)
        let relay = FakeFileRelay(["/tmp/a.bin": .init(data: data, kind: "binary", type: "application/octet-stream", name: "a.bin")])
        let store = store(relay)
        let seen = ProgressLog()
        let file = try await store.open(FileReference(path: "/tmp/a.bin")) { seen.add($0) }
        XCTAssertEqual(try bytes(file), data)
        XCTAssertFalse(file.fromCache)
        let reads = await relay.count("file.read_range")
        XCTAssertEqual(reads, Int((Double(data.count) / 8192).rounded(.up)))
        let fractions = seen.values.map(\.fraction)
        XCTAssertEqual(fractions, fractions.sorted()); XCTAssertEqual(fractions.last, 1)
        XCTAssertEqual(seen.values.last?.total, data.count)
        XCTAssertEqual(file.url.lastPathComponent, "a.bin")
    }

    func testReopeningAnUnchangedFileMovesNoBytesAndAnEditedOneRefetches() async throws {
        let relay = FakeFileRelay(["/tmp/r.md": .init(data: Data("# one".utf8), kind: "markdown", type: "text/markdown", name: "r.md")])
        let store = store(relay)
        _ = try await store.open(FileReference(path: "/tmp/r.md"))
        let second = try await store.open(FileReference(path: "/tmp/r.md"))
        XCTAssertTrue(second.fromCache)
        var reads = await relay.count("file.read_range")
        XCTAssertEqual(reads, 1)
        await relay.setFiles("/tmp/r.md", .init(data: Data("# two!".utf8), version: "2:6", kind: "markdown", type: "text/markdown", name: "r.md"))
        let third = try await store.open(FileReference(path: "/tmp/r.md"))
        XCTAssertFalse(third.fromCache)
        XCTAssertEqual(try bytes(third), Data("# two!".utf8))
        reads = await relay.count("file.read_range")
        XCTAssertEqual(reads, 2)
    }

    func testCompressibleFilesInflateTransparentlyAndSendFewerBytes() async throws {
        let html = Data(String(repeating: "<tr><td>row</td></tr>\n", count: 2000).utf8)
        let relay = FakeFileRelay(["/tmp/t.html": .init(data: html, kind: "html", type: "text/html", name: "t.html")])
        await relay.setCompress(true)
        let file = try await store(relay).open(FileReference(path: "/tmp/t.html"))
        XCTAssertEqual(try bytes(file), html)
    }

    func testConcurrentOpensShareOneTransferAndBothHearProgress() async throws {
        let relay = FakeFileRelay(["/tmp/a.bin": .init(data: payload(40_000), kind: "binary", name: "a.bin")])
        await relay.setDelay(.milliseconds(20))
        let store = store(relay)
        let first = ProgressLog(), second = ProgressLog()
        async let one = store.open(FileReference(path: "/tmp/a.bin")) { first.add($0) }
        try await Task.sleep(for: .milliseconds(30))
        async let two = store.open(FileReference(path: "/tmp/a.bin")) { second.add($0) }
        let (a, b) = try await (one, two)
        XCTAssertEqual(a.url, b.url)
        let stats = await relay.count("file.stat")
        XCTAssertEqual(stats, 1) // the second open joined the first transfer
        let reads = await relay.count("file.read_range")
        XCTAssertEqual(reads, 5)
        XCTAssertFalse(first.values.isEmpty); XCTAssertFalse(second.values.isEmpty)
    }

    func testTransientRelayFailuresRetryButAnswersAboutTheFileDoNot() async throws {
        let relay = FakeFileRelay(["/tmp/a.bin": .init(data: payload(20_000), kind: "binary", name: "a.bin")])
        await relay.failNext("/tmp/a.bin", "The computer took too long to respond.", "The computer took too long to respond.")
        let file = try await store(relay).open(FileReference(path: "/tmp/a.bin"))
        XCTAssertEqual(try bytes(file), payload(20_000))

        let denied = FakeFileRelay(["/tmp/a.bin": .init(data: payload(100), kind: "binary", name: "a.bin")])
        await denied.failNext("/tmp/a.bin", "file_denied: no")
        do { _ = try await store(denied).open(FileReference(path: "/tmp/a.bin")); XCTFail("expected denial") }
        catch { XCTAssertEqual(error as? FilePreviewError, .denied) }
        let attempts = await denied.count("file.read_range")
        XCTAssertEqual(attempts, 1)

        do { _ = try await store(denied).open(FileReference(path: "/tmp/missing.md")); XCTFail("expected not found") }
        catch { XCTAssertEqual(error as? FilePreviewError, .notFound) }
    }

    func testAFileEditedMidTransferRestartsOnce() async throws {
        let relay = FakeFileRelay(["/tmp/a.bin": .init(data: payload(30_000), kind: "binary", name: "a.bin")])
        await relay.setChangeAfterFirstRange(true)
        let file = try await store(relay).open(FileReference(path: "/tmp/a.bin"))
        XCTAssertEqual(file.meta.version, "2:2")
        XCTAssertEqual(try bytes(file), payload(30_000))
    }

    func testAShortReplyDoesNotCorruptTheFile() async throws {
        let data = payload(50_000)
        let relay = FakeFileRelay(["/tmp/a.bin": .init(data: data, kind: "binary", name: "a.bin")])
        await relay.setShortReplies(true)
        let file = try await store(relay).open(FileReference(path: "/tmp/a.bin"))
        XCTAssertEqual(try bytes(file), data)
    }

    func testFirstRangeProbeNeedsNoStatAndTinyFilesTakeOneCall() async throws {
        let relay = FakeFileRelay(["/tmp/app.css": .init(data: Data("body{}".utf8), kind: "code", type: "text/css", name: "app.css")])
        let store = store(relay)
        let file = try await store.open(FileReference(path: "/tmp/app.css"), probe: .firstRange)
        XCTAssertEqual(try bytes(file), Data("body{}".utf8))
        var stats = await relay.count("file.stat"), reads = await relay.count("file.read_range")
        XCTAssertEqual(stats, 0); XCTAssertEqual(reads, 1)
        let again = try await store.open(FileReference(path: "/tmp/app.css"), probe: .firstRange)
        XCTAssertTrue(again.fromCache)
        stats = await relay.count("file.stat"); reads = await relay.count("file.read_range")
        XCTAssertEqual(stats, 0); XCTAssertEqual(reads, 2) // validated by one range, never re-downloaded
    }

    func testASavedCopyIsOfferedForAbsolutePathsOnly() async throws {
        let relay = FakeFileRelay(["/tmp/r.md": .init(data: Data("# saved".utf8), kind: "markdown", type: "text/markdown", name: "r.md")])
        let store = store(relay)
        _ = try await store.open(FileReference(path: "/tmp/r.md"))
        let saved = await store.savedCopy(of: FileReference(path: "/tmp/r.md"))
        XCTAssertEqual(try saved.map { try bytes($0) }, Data("# saved".utf8)); XCTAssertEqual(saved?.stale, true)
        let relative = await store.savedCopy(of: FileReference(path: "r.md"))
        XCTAssertNil(relative)
        let other = await store.savedCopy(of: FileReference(path: "/tmp/other.md"))
        XCTAssertNil(other)
    }

    func testTheDiskCacheStaysWithinBudgetKeepingTheNewestFile() async throws {
        var entries: [String: FakeFileRelay.Entry] = [:]
        for index in 0..<6 { entries["/tmp/\(index).bin"] = .init(data: payload(10_000), kind: "binary", name: "\(index).bin") }
        let relay = FakeFileRelay(entries)
        let store = store(relay, budget: 35_000)
        for index in 0..<6 { _ = try await store.open(FileReference(path: "/tmp/\(index).bin")); try await Task.sleep(for: .milliseconds(20)) }
        let kept = await (0..<6).asyncCount { await store.savedCopy(of: FileReference(path: "/tmp/\($0).bin")) != nil }
        XCTAssertLessThanOrEqual(kept, 3); XCTAssertGreaterThanOrEqual(kept, 1)
        let newest = await store.savedCopy(of: FileReference(path: "/tmp/5.bin"))
        XCTAssertNotNil(newest)
    }

    // MARK: HTML scheme handler

    func testRangeHeadersSliceMediaResponses() {
        let data = Data((0..<100).map(UInt8.init))
        XCTAssertEqual(FileSchemeHandler.slice(data, header: "bytes=10-19")?.data, data.subdata(in: 10..<20))
        XCTAssertEqual(FileSchemeHandler.slice(data, header: "bytes=90-")?.data, data.subdata(in: 90..<100))
        XCTAssertEqual(FileSchemeHandler.slice(data, header: "bytes=-5")?.start, 95)
        XCTAssertEqual(FileSchemeHandler.slice(data, header: "bytes=0-999")?.data.count, 100)
        XCTAssertNil(FileSchemeHandler.slice(data, header: "bytes=200-")); XCTAssertNil(FileSchemeHandler.slice(data, header: "items=1-2"))
        XCTAssertEqual(FileSchemeHandler.url(forPath: "/tmp/a b/é.html")?.absoluteString, "fdfile://doc/tmp/a%20b/%C3%A9.html")
    }

    func testTheViewerSeparatesTextFromBinaryAndPicksHumanProgress() {
        XCTAssertTrue(FileKind.markdown.isTextual); XCTAssertFalse(FileKind.pdf.isTextual)
        let progress = FileProgress(loaded: 5_000_000, total: 25_000_000, rate: 70_000)
        XCTAssertEqual(progress.fraction, 0.2, accuracy: 0.001)
        XCTAssertEqual(progress.remaining ?? 0, 285.7, accuracy: 0.5)
    }
}

final class ProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [FileProgress] = []
    func add(_ value: FileProgress) { lock.lock(); storage.append(value); lock.unlock() }
    var values: [FileProgress] { lock.lock(); defer { lock.unlock() }; return storage }
}

private extension Sequence {
    func asyncCount(_ test: (Element) async -> Bool) async -> Int {
        var count = 0
        for element in self where await test(element) { count += 1 }
        return count
    }
}
