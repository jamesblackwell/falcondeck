import CryptoKit
import Foundation

struct SavedSubmission: Codable, Sendable {
    let id: String
    let text: String
    let attachments: [NativeAttachment]
}

struct SavedDraft: Codable, Sendable {
    let id: String
    var text: String
    var attachments: [NativeAttachment]
    var modelID: String
    var effort: String
    var provider: String
    var overrides: [String: JSON]
    var submission: SavedSubmission?
}

/// Only unsent input and device navigation live here. Conversation history and
/// relay replay remain owned by the daemon. Files are encrypted per pairing.
actor DraftStore {
    private let directory: URL
    private let key: SymmetricKey
    private(set) var unreadableDraftCount = 0
    private var previousComposerPreferences: [String: WorkspaceComposerPreferences]?
    init(session: SavedSession, root: URL? = nil) throws {
        let root = try root ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appending(path: "InputDrafts", directoryHint: .isDirectory)
        let namespace = Self.hash(session.relay.absoluteString + ":" + session.sessionID + ":" + session.deviceID)
        directory = root.appending(path: namespace, directoryHint: .isDirectory)
        key = SymmetricKey(data: SHA256.hash(data: session.secret + Data("falcondeck-native-input-v1".utf8)))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var location = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try location.setResourceValues(values)
    }
    func load() throws -> [SavedDraft] {
        unreadableDraftCount = 0
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter { $0.pathExtension == "draft" }.compactMap { url in
            do { return try JSONDecoder().decode(SavedDraft.self, from: decrypt(Data(contentsOf: url))) }
            catch {
                // Keep damaged input on disk, but recover the independent healthy drafts.
                unreadableDraftCount += 1
                return nil
            }
        }
    }
    func save(_ draft: SavedDraft) throws {
        let url = directory.appending(path: Self.hash(draft.id) + ".draft")
        if draft.text.isEmpty && draft.attachments.isEmpty && draft.submission == nil && draft.overrides.isEmpty && draft.modelID.isEmpty && draft.effort.isEmpty {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        } else { try write(JSONEncoder().encode(draft), to: url) }
    }
    func saveSelection(_ selection: Destination?) throws {
        try write(JSONEncoder().encode(selection), to: directory.appending(path: "selection"))
    }
    func loadSelection() throws -> Destination? {
        let url = directory.appending(path: "selection")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(Destination?.self, from: decrypt(Data(contentsOf: url)))
    }
    func loadComposerPreferences() throws -> [String: WorkspaceComposerPreferences] {
        let url = directory.appending(path: "composer-preferences")
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        let preferences = try JSONDecoder().decode([String: WorkspaceComposerPreferences].self, from: decrypt(Data(contentsOf: url)))
        previousComposerPreferences = preferences
        return preferences
    }
    func saveComposerPreferences(_ preferences: [String: WorkspaceComposerPreferences]) throws {
        guard preferences != previousComposerPreferences else { return }
        try write(JSONEncoder().encode(preferences), to: directory.appending(path: "composer-preferences"))
        previousComposerPreferences = preferences
    }
    func clear() throws { try FileManager.default.removeItem(at: directory) }
    private func write(_ data: Data, to url: URL) throws {
        guard let sealed = try AES.GCM.seal(data, using: key).combined else { throw PilotError("Could not protect the input draft.") }
        try sealed.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private func decrypt(_ data: Data) throws -> Data { try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key) }
    private static func hash(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
}

@MainActor extension ChatSession {
    func saved(id: String) -> SavedDraft { SavedDraft(id: id, text: draft, attachments: attachments, modelID: modelID, effort: effort, provider: provider, overrides: overrides, submission: submission) }
    func restore(_ value: SavedDraft) {
        draft = value.text; attachments = value.attachments; modelID = value.modelID; effort = value.effort; provider = value.provider; overrides = value.overrides
        submission = value.submission
        if let pending = submission {
            if draft.isEmpty { draft = pending.text }
            else if !pending.text.isEmpty, draft != pending.text, !draft.hasPrefix(pending.text + "\n\n") { draft = pending.text + "\n\n" + draft }
            attachments = pending.attachments + attachments.filter { newer in !pending.attachments.contains { $0.id == newer.id } }
            recoveredSubmission = true; notice = "Recovered unsent input. Refresh this task before resending; delivery may already have succeeded."
        }
    }
    func settleSubmission(queued: [JSON] = []) {
        guard let pending = submission else { return }
        let confirmed = transcript.items.contains { $0.id == pending.id && !$0.raw["pending"].bool } || queued.contains { $0["id"].string == pending.id || $0["client_message_id"].string == pending.id }
        guard confirmed else { return }
        if recoveredSubmission {
            if draft == pending.text { draft = "" }
            else if !pending.text.isEmpty, draft.hasPrefix(pending.text + "\n\n") { draft = String(draft.dropFirst(pending.text.count + 2)) }
            attachments.removeAll { attachment in pending.attachments.contains { $0.id == attachment.id } }
            recoveredSubmission = false; notice = "Recovered message was already delivered."
        }
        submission = nil
    }
}
