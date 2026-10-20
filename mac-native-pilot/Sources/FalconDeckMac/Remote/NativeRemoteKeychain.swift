import Foundation
import Security

struct NativeSavedSession: Codable, Sendable {
    let relay: URL
    let sessionID: String
    let deviceID: String
    let token: String
    let secret: Data
    let daemonKey: String
    let daemonIdentity: String
    var dataKey: Data?
}

protocol NativeRemoteCredentialStore: Sendable {
    func load(hostID: String) throws -> NativeSavedSession?
    func save(_ session: NativeSavedSession, hostID: String) throws
    func remove(hostID: String) throws
}

/// Only connection metadata belongs in preferences. Tokens, private identities
/// and unwrapped data keys remain in a separate per-host Keychain item.
struct NativeRemoteKeychain: NativeRemoteCredentialStore {
    private func query(_ hostID: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.falcondeck.mac.native.remote.v1",
         kSecAttrAccount as String: hostID]
    }

    func load(hostID: String) throws -> NativeSavedSession? {
        var attributes = query(hostID)
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = result as? Data else {
            throw PilotError("Could not read the saved server connection from Keychain (\(status)).")
        }
        return try JSONDecoder().decode(NativeSavedSession.self, from: bytes)
    }

    func save(_ session: NativeSavedSession, hostID: String) throws {
        let bytes = try JSONEncoder().encode(session)
        let attributes: [String: Any] = [kSecValueData as String: bytes,
                                       kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query(hostID) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query(hostID).merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PilotError("Could not save the server connection in Keychain (\(status)).") }
    }

    func remove(hostID: String) throws {
        let status = SecItemDelete(query(hostID) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw PilotError("Could not remove the saved server credentials (\(status)).")
        }
    }
}

protocol NativeRemoteTransport: Sendable {
    func events() async -> AsyncStream<NativeRelayUpdate>
    func pair(_ input: NativePairingInput, connectionID: UUID) async throws
    func restore(connectionID: UUID) async throws -> Bool
    func disconnect(forget: Bool) async throws
    func refresh() async
    func selectThread(_ id: String?) async
    func setForeground(_ active: Bool) async
    func call(_ method: String, params: JSON) async throws -> JSON
}
