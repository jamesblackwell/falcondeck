import CryptoKit
import Foundation

struct CachedHistory: Codable, Sendable, Equatable {
    var items: [JSON]
    var hasOlder: Bool
}

/// A disposable rendering cache, never a source of conversation truth. No
/// replay cursor, sync token, pending send, or approval is restored from disk.
struct SessionCache: Codable, Sendable, Equatable {
    var version = 1
    var savedAt = Date.now
    var projects: [JSON]
    var tasks: [JSON]
    var preferences: JSON
    var histories: [String: CachedHistory]
}

struct SessionCacheInput: Sendable {
    var projects: [JSON]
    var tasks: [JSON]
    var preferences: JSON
    var selectedID: String?
    var histories: [String: CachedHistory]
}

/// Serialization, trimming, encryption and disk I/O run off the UI actor.
/// Limits match Expo: five contiguous history tails, 150 items / 64 KiB each.
actor SessionCacheStore {
    static let maxFileBytes = 4 * 1024 * 1024
    private let directory: URL
    private let file: URL
    private let key: SymmetricKey
    private var previous: SessionCache?
    private var cleared = false

    init(session: SavedSession, root: URL? = nil) throws {
        let root = try root ?? FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appending(path: "SessionPreviews", directoryHint: .isDirectory)
        let identity = session.relay.absoluteString + ":" + session.sessionID + ":" + session.deviceID
        let namespace = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        directory = root.appending(path: namespace, directoryHint: .isDirectory)
        file = directory.appending(path: "preview")
        key = SymmetricKey(data: SHA256.hash(data: session.secret + Data("falcondeck-native-preview-v1".utf8)))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var location = directory, values = URLResourceValues()
        values.isExcludedFromBackup = true; try location.setResourceValues(values)
    }

    func load() -> SessionCache? {
        guard !cleared, FileManager.default.fileExists(atPath: file.path) else { return nil }
        do {
            let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= Self.maxFileBytes else { throw PilotError("Preview too large") }
            let encrypted = try Data(contentsOf: file)
            let data = try AES.GCM.open(AES.GCM.SealedBox(combined: encrypted), using: key)
            let cache = try JSONDecoder().decode(SessionCache.self, from: data)
            guard cache.version == 1, cache.tasks.count <= 200, cache.histories.count <= 5 else { throw PilotError("Unsupported preview") }
            previous = cache
            return cache
        } catch {
            // Missing/corrupt/evicted previews are a cache miss, never a broken
            // pairing or a reason to discard the separately protected drafts.
            try? FileManager.default.removeItem(at: file)
            return nil
        }
    }

    func save(_ input: SessionCacheInput) throws {
        guard !cleared else { return }
        let active = input.tasks.filter { !$0["is_archived"].bool }
        let recent = active.sorted { $0["updated_at"].string > $1["updated_at"].string }
        var ids = Set<String>(), rows: [JSON] = []
        func keep(_ row: JSON) {
            guard rows.count < 200, !row["id"].string.isEmpty, ids.insert(row["id"].string).inserted else { return }
            rows.append(row.setting("latest_plan", .null).setting("latest_diff", .null).setting("queued_turns", .array([])).setting("goal", .null))
        }
        if let selected = active.first(where: { $0["id"].string == input.selectedID }) { keep(selected) }
        for row in recent where row["is_pinned"].bool { keep(row) }
        // At least one recent task per project before filling the remaining
        // budget, so a busy workspace cannot crowd every other project out.
        var projectsSeen = Set<String>()
        for row in recent where projectsSeen.insert(row["workspace_id"].string).inserted { keep(row) }
        for row in recent { keep(row) }
        var histories: [String: CachedHistory] = [:]
        let candidates = rows.filter { input.histories[$0["id"].string] != nil || previous?.histories[$0["id"].string] != nil }.prefix(5)
        for row in candidates {
            let id = row["id"].string
            // Never persist partial streaming output. Keep the last settled
            // tail until the next authoritative history / completed turn.
            let history = row["status"].string == "running" ? previous?.histories[id] : input.histories[id] ?? previous?.histories[id]
            guard let history else { continue }
            let confirmed = history.items.filter { !$0["pending"].bool }
            var tail: [JSON] = [], remaining = 64 * 1024
            for item in confirmed.suffix(150).reversed() {
                let size = try item.data().count
                guard size <= remaining else { break }
                remaining -= size; tail.append(item)
            }
            guard !tail.isEmpty else { continue }
            histories[id] = CachedHistory(items: tail.reversed(), hasOlder: history.hasOlder || tail.count < confirmed.count)
        }
        let projects = input.projects.map { project in
            project.setting("skills", .array([])).setting("models", .array([])).setting("agents", .array(project["agents"].array.map {
                $0.setting("skills", .array([])).setting("models", .array([]))
            }))
        }
        var cache = SessionCache(projects: projects, tasks: rows, preferences: input.preferences, histories: histories)
        // Avoid re-encrypting identical content just because a refresh completed.
        if let previous { cache.savedAt = previous.savedAt; if cache == previous { return } }
        cache.savedAt = .now
        let data = try JSONEncoder().encode(cache)
        guard data.count + 28 <= Self.maxFileBytes else { return }
        guard let encrypted = try AES.GCM.seal(data, using: key).combined else { return }
        try encrypted.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        previous = cache
    }

    func clear() throws {
        cleared = true; previous = nil
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }
}
