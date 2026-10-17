import Foundation
import Security

struct SavedSession: Codable, Sendable {
    let relay: URL
    let sessionID: String
    let deviceID: String
    let token: String
    let secret: Data
    let daemonKey: String
    let daemonIdentity: String
    var dataKey: Data?
}

/// The pilot has its own Keychain namespace. No credentials or transcripts are
/// read from the existing app, and no session secrets go to UserDefaults.
enum SessionVault {
    private static let query: [String: String] = [
        kSecClass as String: kSecClassGenericPassword as String,
        kSecAttrService as String: "com.falcondeck.pilot.native",
        kSecAttrAccount as String: "relay-session-v1"
    ]
    static func load() throws -> SavedSession? {
        var q = query as [String: Any]
        q[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw PilotError("Could not read the saved connection from Keychain (\(status)).") }
        return try JSONDecoder().decode(SavedSession.self, from: data)
    }
    static func save(_ session: SavedSession) throws {
        let data = try JSONEncoder().encode(session)
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd((query as [String: Any]).merging(attrs) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PilotError("Could not save the connection in Keychain (\(status)).") }
    }
    static func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PilotError("Could not remove the saved connection.") }
    }
}
