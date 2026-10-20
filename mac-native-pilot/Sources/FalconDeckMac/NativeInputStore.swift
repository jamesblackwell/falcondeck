import CryptoKit
import Foundation
import Security

struct NativeInputSnapshot: Codable, Sendable {
    var drafts: [String: String] = [:]
    var payloads: [String: JSON] = [:]
    var submissions: [String: NativePendingSubmission] = [:]

    init(drafts: [String: String] = [:], payloads: [String: JSON] = [:], submissions: [String: NativePendingSubmission] = [:]) {
        self.drafts = drafts; self.payloads = payloads; self.submissions = submissions
    }

    private enum CodingKeys: String, CodingKey { case drafts, payloads, submissions }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        drafts = try values.decodeIfPresent([String: String].self, forKey: .drafts) ?? [:]
        payloads = try values.decodeIfPresent([String: JSON].self, forKey: .payloads) ?? [:]
        submissions = try values.decodeIfPresent([String: NativePendingSubmission].self, forKey: .submissions) ?? [:]
    }
}

struct NativePendingSubmission: Codable, Sendable, Equatable, Identifiable {
    enum Status: String, Codable, Sendable { case prepared, uncertain, checking, checkedMissing }
    var id: String
    var userItemID: String
    var sourceKey: String
    var composerKey: String
    var projectID: String
    var threadID: String?
    var provider: String
    var inputs: [JSON]
    var settings: [String: JSON]
    var draft: String
    var payload: JSON
    var knownQueueIDs: Set<String>
    var status: Status = .prepared
    var lastError: String?
    var preserveComposer: Bool? = nil
}

/// Recoverable user input, separate from disposable conversation previews.
actor NativeInputStore {
    static let shared = NativeInputStore()
    private let file: URL
    private let service: String
    private let maximumPlaintextBytes: Int
    // CryptoKit's combined AES-GCM representation includes a 12-byte nonce and 16-byte tag.
    private let encryptionOverheadBytes = 28
    private var key: SymmetricKey?
    private var latestRevision: UInt64 = 0

    init(directory: URL? = nil, service: String = "com.falcondeck.mac-native-pilot.input", encryptionKey: SymmetricKey? = nil,
         maximumPlaintextBytes: Int = 128 * 1024 * 1024) {
        let root = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FalconDeck Native", isDirectory: true)
        file = root.appendingPathComponent("input.enc")
        self.service = service
        self.key = encryptionKey
        self.maximumPlaintextBytes = maximumPlaintextBytes
    }

    func load() throws -> NativeInputSnapshot { try loadWithRevision().value }

    /// A replacement writer must continue this actor's revision sequence.
    /// Reading both together keeps its first save newer than the recovered input.
    func loadWithRevision() throws -> (value: NativeInputSnapshot, revision: UInt64) {
        guard FileManager.default.fileExists(atPath: file.path) else { return (.init(), latestRevision) }
        let size = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0
        guard size <= maximumPlaintextBytes + encryptionOverheadBytes else { throw PilotError("Saved input exceeds the recovery limit.") }
        let data = try Data(contentsOf: file)
        let plaintext = try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: loadKey())
        guard plaintext.count <= maximumPlaintextBytes else { throw PilotError("Saved input exceeds the recovery limit.") }
        return (try JSONDecoder().decode(NativeInputSnapshot.self, from: plaintext), latestRevision)
    }

    func save(_ value: NativeInputSnapshot, revision: UInt64) throws {
        guard revision >= latestRevision else { return }
        let data = try JSONEncoder().encode(value)
        guard data.count <= maximumPlaintextBytes else { throw PilotError("Saved input exceeds the recovery limit.") }
        let encrypted = try AES.GCM.seal(data, using: loadKey()).combined
        guard let encrypted else { throw PilotError("Input encryption failed.") }
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try encrypted.write(to: file, options: .atomic)
        latestRevision = revision
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    private func loadKey() throws -> SymmetricKey {
        if let key { return key }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "input-key",
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, data.count == 32 {
            let key = SymmetricKey(data: data); self.key = key; return key
        }
        guard status == errSecItemNotFound else { throw PilotError("Input recovery key is unavailable (\(status)).") }
        let generated = SymmetricKey(size: .bits256)
        var record = query
        record.removeValue(forKey: kSecReturnData as String)
        record.removeValue(forKey: kSecMatchLimit as String)
        record[kSecValueData as String] = generated.withUnsafeBytes { Data($0) }
        record[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let saved = SecItemAdd(record as CFDictionary, nil)
        if saved == errSecDuplicateItem { return try loadKey() }
        guard saved == errSecSuccess else { throw PilotError("Input recovery key couldn’t be saved (\(saved)).") }
        key = generated
        return generated
    }
}
