import Foundation

/// Records read while the computer was out of reach, waiting to be replayed
/// through `notifications.mark_read`. Only record ids, keyed by session. Forgetting
/// a computer clears every session's set.
struct NotificationOfflineReads {
    static let limit = 500
    private static let prefix = "native.notifications.offlineReads."
    private let defaults: UserDefaults
    init(defaults: UserDefaults) { self.defaults = defaults }

    private static func key(_ sessionID: String) -> String { prefix + sessionID }
    func load(sessionID: String) -> Set<String> { Set(defaults.stringArray(forKey: Self.key(sessionID)) ?? []) }
    func save(_ ids: Set<String>, sessionID: String) {
        if ids.isEmpty { defaults.removeObject(forKey: Self.key(sessionID)) }
        else { defaults.set(Array(ids.sorted().suffix(Self.limit)), forKey: Self.key(sessionID)) }
    }
    /// Drops what a previous pairing left behind.
    func retain(sessionID: String) {
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(Self.prefix) && key != Self.key(sessionID) { defaults.removeObject(forKey: key) }
    }
    func purge() {
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(Self.prefix) { defaults.removeObject(forKey: key) }
    }
}

/// Unsent replies, encrypted per pairing like the composer's drafts, so a
/// dictated reply survives a relaunch. Its own folder keeps the composer out.
struct NotificationReplyVault: Sendable {
    private let store: DraftStore
    private static let prefix = "notification-reply:"

    static func defaultRoot() -> URL? {
        try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appending(path: "NotificationReplies", directoryHint: .isDirectory)
    }
    init?(session: SavedSession, root: URL?) {
        guard let root = root ?? Self.defaultRoot(), let store = try? DraftStore(session: session, root: root) else { return nil }
        self.store = store
    }
    static func purge(root: URL?) {
        if let root = root ?? defaultRoot() { try? FileManager.default.removeItem(at: root) }
    }
    /// An empty record deletes the file, which is how a sent reply clears itself.
    func save(_ text: String, notificationID: String) async throws {
        try await store.save(SavedDraft(id: Self.prefix + notificationID, text: text, attachments: [], modelID: "", effort: "", provider: "", overrides: [:]))
    }
    func load() async -> [String: String] {
        var result: [String: String] = [:]
        for record in (try? await store.load()) ?? [] where record.id.hasPrefix(Self.prefix) && !record.text.isEmpty {
            result[String(record.id.dropFirst(Self.prefix.count))] = record.text
        }
        return result
    }
}
