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
    var modelCatalogs: [CachedModelCatalog]? = nil
}

struct SessionCacheInput: Sendable {
    var projects: [JSON]
    var tasks: [JSON]
    var preferences: JSON
    var selectedID: String?
    var histories: [String: CachedHistory]
    var modelCatalogs: [CachedModelCatalog] = []
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
    private var images: [String: CachedImage] = [:]
    private var imageOrder: [String] = []
    private var imageBytes = 0
    private let imageDiskBudget: Int
    private static let imageMemoryBudget = 16 * 1024 * 1024
    private static let maxImageFileBytes = 48 * 1024 * 1024

    init(session: SavedSession, root: URL? = nil, imageDiskBudget: Int = 64 * 1024 * 1024) throws {
        self.imageDiskBudget = max(0, imageDiskBudget)
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
            var validated = cache
            validated.modelCatalogs = CachedModelCatalog.bounded(cache.modelCatalogs ?? [])
            previous = validated
            return validated
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
        let projectIDs = Set(input.projects.map { $0["id"].string })
        let catalogs = CachedModelCatalog.bounded(input.modelCatalogs.filter { projectIDs.contains($0.projectID) })
        var cache = SessionCache(projects: projects, tasks: rows, preferences: input.preferences, histories: histories, modelCatalogs: catalogs)
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
        cleared = true; previous = nil; images = [:]; imageOrder = []; imageBytes = 0
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }

    // Image bytes are disposable, encrypted render artifacts kept separately
    // from the small transcript preview and its contiguous-history budget.
    func loadImage(_ identity: [String]) -> CachedImage? {
        guard !cleared, let id = imageKey(identity) else { return nil }
        let file = directory.appending(path: "images").appending(path: id)
        if let image = images[id] {
            if image.valid {
                rememberImage(image, id: id)
                try? FileManager.default.setAttributes([.modificationDate: Date.now], ofItemAtPath: file.path)
                return image
            }
            if let old = images.removeValue(forKey: id) { imageBytes -= old.cost }
            imageOrder.removeAll { $0 == id }
        }
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        do {
            let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= Self.maxImageFileBytes else { throw PilotError("Image cache entry too large") }
            let data = try AES.GCM.open(AES.GCM.SealedBox(combined: Data(contentsOf: file)), using: key, authenticating: Data(id.utf8))
            let image = try PropertyListDecoder().decode(CachedImage.self, from: data)
            guard image.valid else { throw PilotError("Image cache entry expired") }
            rememberImage(image, id: id)
            try? FileManager.default.setAttributes([.modificationDate: Date.now], ofItemAtPath: file.path)
            return image
        } catch { try? FileManager.default.removeItem(at: file); return nil }
    }

    func saveImage(_ image: CachedImage, identity: [String]) throws {
        guard !cleared, image.valid, let id = imageKey(identity) else { return }
        rememberImage(image, id: id)
        let encoder = PropertyListEncoder(); encoder.outputFormat = .binary
        let data = try encoder.encode(image)
        guard data.count + 28 <= min(imageDiskBudget, Self.maxImageFileBytes),
              let encrypted = try AES.GCM.seal(data, using: key, authenticating: Data(id.utf8)).combined else { return }
        let folder = directory.appending(path: "images", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try encrypted.write(to: folder.appending(path: id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]).compactMap { url -> (url: URL, size: Int, date: Date)? in
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
            return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }.sorted { $0.date < $1.date }
        var bytes = files.reduce(0) { $0 + $1.size }, count = files.count
        for entry in files where bytes > imageDiskBudget || count > 128 {
            try FileManager.default.removeItem(at: entry.url); bytes -= entry.size; count -= 1
        }
    }

    private func imageKey(_ identity: [String]) -> String? {
        guard let encoded = try? JSONEncoder().encode(identity) else { return nil }
        return SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
    }
    private func rememberImage(_ image: CachedImage, id: String) {
        if let old = images.removeValue(forKey: id) { imageBytes -= old.cost }
        imageOrder.removeAll { $0 == id }
        guard image.cost <= Self.imageMemoryBudget else { return }
        images[id] = image; imageOrder.append(id); imageBytes += image.cost
        while imageBytes > Self.imageMemoryBudget || images.count > 48, let oldest = imageOrder.first {
            if let old = images.removeValue(forKey: oldest) { imageBytes -= old.cost }
            imageOrder.removeFirst()
        }
    }
}
