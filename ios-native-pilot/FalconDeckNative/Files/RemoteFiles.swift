import CryptoKit
import Foundation

enum FileKind: String, Sendable {
    case markdown, html, pdf, image, video, audio, code, text, binary
    var isTextual: Bool { [.markdown, .html, .code, .text].contains(self) }
}

/// What `file.stat` and every `file.read_range` reply say about a file.
struct FileMeta: Sendable, Equatable, Codable {
    let path: String
    let name: String
    let size: Int
    let modifiedMs: Int
    let version: String
    let contentType: String
    let kind: String
    let maxRange: Int

    init?(_ json: JSON) {
        guard !json["path"].string.isEmpty, !json["version"].string.isEmpty else { return nil }
        path = json["path"].string; name = json["name"].string.nonempty ?? (json["path"].string as NSString).lastPathComponent
        size = json["size_bytes"].int; modifiedMs = json["modified_ms"].int; version = json["version"].string
        contentType = json["content_type"].string.nonempty ?? "application/octet-stream"
        kind = json["kind"].string.nonempty ?? "binary"
        maxRange = max(1024, json["max_range_bytes"].int)
    }
    var fileKind: FileKind { FileKind(rawValue: kind) ?? .binary }
    var modified: Date { Date(timeIntervalSince1970: Double(modifiedMs) / 1000) }
    /// Text-like payloads shrink about 4x when the computer deflates them.
    var compressible: Bool { fileKind.isTextual || contentType == "image/svg+xml" }
}

/// Failures a viewer can explain. The daemon prefixes its messages with a stable
/// code; everything else is a connection or relay problem.
enum FilePreviewError: LocalizedError, Equatable, Sendable {
    case denied, notFound, tooLarge(String), changed, unsupported(String), notConnected, failed(String)

    init(_ error: Error) {
        if let error = error as? FilePreviewError { self = error; return }
        let message = error.localizedDescription
        if let match = message.range(of: #"file_(denied|not_found|too_large|changed|unsupported):\s*"#, options: .regularExpression) {
            let code = message[match].dropFirst(5).dropLast(2).trimmingCharacters(in: .whitespaces)
            let detail = String(message[match.upperBound...])
            switch code {
            case "denied": self = .denied
            case "not_found": self = .notFound
            case "too_large": self = .tooLarge(detail)
            case "changed": self = .changed
            default: self = .unsupported(detail)
            }
        } else if message.contains("Connect to your computer") {
            self = .notConnected
        } else {
            self = .failed(message)
        }
    }

    var title: String {
        switch self {
        case .denied: "This file isn't shareable from your Mac"
        case .notFound: "File not found"
        case .tooLarge: "File too large"
        case .changed: "The file changed"
        case .unsupported: "Can't open this"
        case .notConnected: "Mac not connected"
        case .failed: "Couldn't load this file"
        }
    }
    var detail: String {
        switch self {
        case .denied: "FalconDeck only opens files in your projects, bot spaces and artifact folders, and never keys, tokens or .env files."
        case .notFound: "It no longer exists on your Mac, or the link points somewhere else."
        case .tooLarge(let message): message.nonempty ?? "Previews on your phone are limited to 25 MB."
        case .changed: "It was edited on your Mac while loading. Try again."
        case .unsupported(let message): message.nonempty ?? "Only files can be opened."
        case .notConnected: "Connect to your computer to open this file."
        case .failed(let message): message
        }
    }
    var symbol: String {
        switch self {
        case .denied: "lock.fill"
        case .notFound: "questionmark.folder"
        case .tooLarge: "externaldrive.badge.exclamationmark"
        case .notConnected: "wifi.slash"
        default: "exclamationmark.triangle"
        }
    }
    /// Worth a Retry button: nothing about the file itself ruled it out.
    var retryable: Bool {
        switch self {
        case .denied, .notFound, .tooLarge, .unsupported: false
        case .changed, .notConnected, .failed: true
        }
    }
    var errorDescription: String? { title }
}

struct FileProgress: Sendable, Equatable {
    var loaded: Int
    var total: Int
    /// Smoothed bytes per second of file content; 0 until measured.
    var rate: Double
    var fraction: Double { total > 0 ? min(1, Double(loaded) / Double(total)) : 0 }
    var remaining: TimeInterval? { rate > 1 && total > loaded ? Double(total - loaded) / rate : nil }
}

struct LoadedFile: Sendable, Equatable {
    let meta: FileMeta
    let url: URL
    var fromCache: Bool
    /// True when the computer could not be reached and this is a saved copy.
    var stale = false
}

/// Disposable copies of files read from the computer, keyed by canonical path
/// and `version` (mtime + size) so an edited file is fetched again and an
/// unchanged one reopens without moving a byte. Entries keep the original
/// file name so Share and Save to Files offer the real thing.
final class FileDiskCache: @unchecked Sendable {
    static let defaultBudget = 256 * 1024 * 1024
    private let root: URL
    private let budget: Int
    private let manager = FileManager.default

    init(root: URL, budget: Int = FileDiskCache.defaultBudget) {
        self.root = root; self.budget = budget
        try? manager.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var location = root, values = URLResourceValues()
        values.isExcludedFromBackup = true; try? location.setResourceValues(values)
    }

    static func defaultRoot(namespace: String) -> URL {
        let caches = (try? FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? FileManager.default.temporaryDirectory
        return caches.appending(path: "FilePreviews/\(namespace)", directoryHint: .isDirectory)
    }

    private func digest(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined() }
    private func directory(path: String, version: String) -> URL {
        root.appending(path: digest(path), directoryHint: .isDirectory).appending(path: digest(version), directoryHint: .isDirectory)
    }
    private func safeName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "\0", with: "")
        return cleaned.nonempty ?? "file"
    }
    func fileURL(_ meta: FileMeta) -> URL { directory(path: meta.path, version: meta.version).appending(path: safeName(meta.name)) }

    func lookup(_ meta: FileMeta) -> URL? {
        let url = fileURL(meta)
        guard let attributes = try? manager.attributesOfItem(atPath: url.path), (attributes[.size] as? Int) == meta.size else { return nil }
        touch(url.deletingLastPathComponent())
        return url
    }

    /// The newest saved copy of `path`, for showing something when offline.
    func latest(path: String) -> LoadedFile? {
        let parent = root.appending(path: digest(path), directoryHint: .isDirectory)
        let versions = (try? manager.contentsOfDirectory(at: parent, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for directory in versions.sorted(by: { modified($0) > modified($1) }) {
            guard let data = try? Data(contentsOf: directory.appending(path: "meta.json")), let meta = try? JSONDecoder().decode(FileMeta.self, from: data),
                  meta.path == path, let url = lookup(meta) else { continue }
            return LoadedFile(meta: meta, url: url, fromCache: true, stale: true)
        }
        return nil
    }

    func newPart() -> URL {
        let parts = root.appending(path: ".parts", directoryHint: .isDirectory)
        try? manager.createDirectory(at: parts, withIntermediateDirectories: true)
        let url = parts.appending(path: UUID().uuidString)
        manager.createFile(atPath: url.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return url
    }

    func commit(_ part: URL, meta: FileMeta) throws -> URL {
        let directory = directory(path: meta.path, version: meta.version)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        let url = fileURL(meta)
        if manager.fileExists(atPath: url.path) { try manager.removeItem(at: url) }
        try manager.moveItem(at: part, to: url)
        try? JSONEncoder().encode(meta).write(to: directory.appending(path: "meta.json"))
        // An edited file's older copies are dead weight.
        let siblings = (try? manager.contentsOfDirectory(at: directory.deletingLastPathComponent(), includingPropertiesForKeys: nil)) ?? []
        for sibling in siblings where !sameLocation(sibling, directory) { try? manager.removeItem(at: sibling) }
        evict(keeping: directory)
        return url
    }

    func discard(_ part: URL) { try? manager.removeItem(at: part) }

    func removeAll() { try? manager.removeItem(at: root) }

    // Enumeration resolves aliases such as /var -> /private/var. Compare both
    // sides in the same form, so cleanup never removes the file just committed.
    private func sameLocation(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.resolvingSymlinksInPath().standardizedFileURL.path == rhs.resolvingSymlinksInPath().standardizedFileURL.path
    }

    private func modified(_ url: URL) -> Date { (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast }
    private func touch(_ url: URL) { try? manager.setAttributes([.modificationDate: Date.now], ofItemAtPath: url.path) }

    private func size(of directory: URL) -> Int {
        let files = (try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0) }
    }

    private func evict(keeping keep: URL) {
        var entries: [(url: URL, date: Date, size: Int)] = []
        for bucket in (try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] where bucket.lastPathComponent != ".parts" {
            for version in (try? manager.contentsOfDirectory(at: bucket, includingPropertiesForKeys: nil)) ?? [] {
                entries.append((version, modified(version), size(of: version)))
            }
        }
        var total = entries.reduce(0) { $0 + $1.size }
        for entry in entries.sorted(by: { $0.date < $1.date }) where total > budget && !sameLocation(entry.url, keep) {
            try? manager.removeItem(at: entry.url)
            try? manager.removeItem(at: entry.url.deletingLastPathComponent()) // only succeeds when empty
            total -= entry.size
        }
    }
}

/// Reads files from the paired computer in relay-sized ranges, with progress,
/// de-duplication and a disk cache. Nothing here knows about any one screen: the
/// viewer, inline images and the HTML scheme handler all share it.
actor RemoteFileStore {
    enum Probe: Sendable {
        /// One tiny `file.stat` first, so an unchanged file reopens instantly.
        case stat
        /// Straight to the first range, which also carries the metadata; for
        /// page assets, where most files fit in that one reply.
        case firstRange
    }

    private struct Reply { let meta: FileMeta; let offset: Int; let length: Int; let eof: Bool; let data: Data }
    private struct Inflight { let task: Task<LoadedFile, Error>; var listeners: [UUID: @Sendable (FileProgress) -> Void] }

    static let concurrentRanges = 2
    private let relay: any RelayServing
    private let cache: FileDiskCache
    private var inflight: [String: Inflight] = [:]
    private let retryDelay: Duration

    init(relay: any RelayServing, cache: FileDiskCache, retryDelay: Duration = .seconds(1)) {
        self.relay = relay; self.cache = cache; self.retryDelay = retryDelay
    }

    func stat(_ reference: FileReference) async throws -> FileMeta {
        do {
            let reply = try await relay.call("file.stat", params: .object(reference.params))
            guard let meta = FileMeta(reply) else { throw FilePreviewError.failed("The computer sent an unreadable reply.") }
            return meta
        } catch { throw FilePreviewError(error) }
    }

    /// Downloads (or finds cached) `reference`. Concurrent calls for the same
    /// file share one transfer and each hear its progress.
    func open(_ reference: FileReference, probe: Probe = .stat, progress: (@Sendable (FileProgress) -> Void)? = nil) async throws -> LoadedFile {
        let key = "\(probe)|\(reference.id)"
        let listener = UUID()
        if var existing = inflight[key] {
            if let progress { existing.listeners[listener] = progress; inflight[key] = existing }
            return try await existing.task.value
        }
        let task = Task { try await self.download(reference, probe: probe, key: key) }
        inflight[key] = Inflight(task: task, listeners: progress.map { [listener: $0] } ?? [:])
        defer { inflight[key] = nil }
        do { return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() } }
        catch is CancellationError { throw CancellationError() }
        catch { throw FilePreviewError(error) }
    }

    /// A saved copy of an absolute path, for when the computer cannot be reached.
    func savedCopy(of reference: FileReference) -> LoadedFile? {
        guard reference.path.hasPrefix("/") else { return nil }
        return cache.latest(path: reference.path)
    }

    func clearCache() { cache.removeAll() }

    private func report(_ key: String, _ progress: FileProgress) {
        for listener in inflight[key]?.listeners.values ?? [:].values { listener(progress) }
    }

    private func download(_ reference: FileReference, probe: Probe, key: String) async throws -> LoadedFile {
        var attempt = 0
        while true {
            do { return try await transfer(reference, probe: probe, key: key) }
            catch FilePreviewError.changed where attempt < 1 { attempt += 1 }
        }
    }

    private func transfer(_ reference: FileReference, probe: Probe, key: String) async throws -> LoadedFile {
        let meta: FileMeta
        var first: Reply?
        switch probe {
        case .stat:
            meta = try await stat(reference)
            if let url = cache.lookup(meta) { return LoadedFile(meta: meta, url: url, fromCache: true) }
        case .firstRange:
            let reply = try await readRange(reference, offset: 0, length: 128 * 1024, compress: true, version: nil)
            meta = reply.meta
            if let url = cache.lookup(meta) { return LoadedFile(meta: meta, url: url, fromCache: true) }
            first = reply
        }
        // Later ranges name the canonical path; no base directory is needed.
        let canonical = FileReference(path: meta.path)
        let part = cache.newPart()
        guard let handle = try? FileHandle(forWritingTo: part) else { throw FilePreviewError.failed("The phone has no room to save this file.") }
        var pending: [(length: Int, task: Task<Reply, Error>)] = []
        func cancelPending() { for entry in pending { entry.task.cancel() }; pending = [] }
        do {
            let started = ContinuousClock.now
            var written = 0, rate = 0.0
            func advance(_ reply: Reply) throws {
                try handle.write(contentsOf: reply.data)
                written += reply.length
                let elapsed = (ContinuousClock.now - started).seconds
                if elapsed > 0.2 { let measured = Double(written) / elapsed; rate = rate == 0 ? measured : rate * 0.6 + measured * 0.4 }
            }
            if let first { try advance(first) }
            report(key, FileProgress(loaded: written, total: meta.size, rate: rate))
            let chunk = meta.compressible ? meta.maxRange : min(meta.maxRange, 128 * 1024)
            var next = written
            func launch() {
                while pending.count < Self.concurrentRanges, next < meta.size {
                    let offset = next, length = min(chunk, meta.size - next)
                    next += length
                    pending.append((length, Task { try await self.readRange(canonical, offset: offset, length: length, compress: meta.compressible, version: meta.version) }))
                }
            }
            launch()
            while written < meta.size, !pending.isEmpty {
                try Task.checkCancellation()
                let entry = pending.removeFirst()
                let reply = try await entry.task.value
                guard reply.offset == written else { throw FilePreviewError.changed }
                if reply.length == 0 { throw FilePreviewError.failed("The file ended early on your Mac.") }
                try advance(reply)
                report(key, FileProgress(loaded: written, total: meta.size, rate: rate))
                // A short reply (the file shrank) invalidates the offsets queued behind it.
                if reply.length < entry.length { cancelPending(); next = written }
                if reply.eof { break }
                launch()
            }
            try handle.close()
            guard written == meta.size else { throw FilePreviewError.changed }
            let url = try cache.commit(part, meta: meta)
            return LoadedFile(meta: meta, url: url, fromCache: false)
        } catch {
            cancelPending()
            try? handle.close()
            cache.discard(part)
            throw error
        }
    }

    private func readRange(_ reference: FileReference, offset: Int, length: Int, compress: Bool, version: String?) async throws -> Reply {
        var params = reference.params
        params["offset"] = .number(Double(offset)); params["length"] = .number(Double(length)); params["compress"] = .bool(compress)
        if let version { params["version"] = .string(version) }
        var failures = 0
        while true {
            do {
                try Task.checkCancellation()
                let reply = try await relay.call("file.read_range", params: .object(params))
                guard let meta = FileMeta(reply), let data = Data(base64Encoded: reply["data_base64"].string) else {
                    throw FilePreviewError.failed("The computer sent an unreadable reply.")
                }
                let payload = reply["encoding"].string == "deflate" ? try Self.inflate(data) : data
                let covered = reply["length"].int
                guard payload.count == covered else { throw FilePreviewError.failed("The computer sent a damaged range.") }
                return Reply(meta: meta, offset: reply["offset"].int, length: covered, eof: reply["eof"].bool, data: payload)
            } catch {
                let failure = FilePreviewError(error)
                // Only relay hiccups are worth another try; the file's own answers are final.
                guard case .failed = failure, !(error is CancellationError), failures < 2 else { throw failure }
                failures += 1
                try await Task.sleep(for: retryDelay)
            }
        }
    }

    /// The daemon sends raw RFC 1951 deflate, which is what `.zlib` means here.
    static func inflate(_ data: Data) throws -> Data {
        do { return try (data as NSData).decompressed(using: .zlib) as Data }
        catch { throw FilePreviewError.failed("The computer sent a damaged range.") }
    }
}

private extension Duration {
    var seconds: Double { Double(components.seconds) + Double(components.attoseconds) / 1e18 }
}
