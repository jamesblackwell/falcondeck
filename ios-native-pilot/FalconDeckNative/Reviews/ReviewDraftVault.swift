import Foundation

/// Unsent review notes, encrypted per pairing like the composer's drafts. It
/// reuses `DraftStore`, under its own folder so the composer never sees these.
struct ReviewDraftVault: Sendable {
    private let store: DraftStore
    private static let prefix = "review:"

    static func defaultRoot() -> URL? {
        try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appending(path: "ReviewDrafts", directoryHint: .isDirectory)
    }
    init?(session: SavedSession, root: URL?) {
        guard let root = root ?? Self.defaultRoot(), let store = try? DraftStore(session: session, root: root) else { return nil }
        self.store = store
    }
    /// Removes every pairing's notes, after the computer was forgotten.
    static func purge(root: URL?) {
        if let root = root ?? defaultRoot() { try? FileManager.default.removeItem(at: root) }
    }

    func save(_ draft: ReviewDraft, reviewID: String) async throws {
        let text = draft.isEmpty ? "" : String(decoding: try JSONEncoder().encode(draft), as: UTF8.self)
        // An empty record deletes the file, which is how a sent review clears its notes.
        try await store.save(SavedDraft(id: Self.prefix + reviewID, text: text, attachments: [], modelID: "", effort: "", provider: "", overrides: [:]))
    }
    func load() async -> [String: ReviewDraft] {
        let saved = (try? await store.load()) ?? []
        var result: [String: ReviewDraft] = [:]
        for record in saved where record.id.hasPrefix(Self.prefix) {
            if let draft = try? JSONDecoder().decode(ReviewDraft.self, from: Data(record.text.utf8)) { result[String(record.id.dropFirst(Self.prefix.count))] = draft }
        }
        return result
    }
}
