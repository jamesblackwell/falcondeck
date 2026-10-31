import AppKit
import CommonCrypto
import CryptoKit
import Foundation
import Observation
import Security
import SwiftUI

/// Versioned authenticated encryption; neither passwords nor plaintext archives go to disk.
/// KDF parameters are fixed by the format, so hostile files cannot request arbitrary work.
enum NativeRecoveryCrypto {
    private static let magic = Data("FDRECOVERY1\n".utf8)
    private static func key(password: String, salt: Data) throws -> SymmetricKey {
        let passwordBytes = Array(password.utf8)
        var derived = [UInt8](repeating: 0, count: 32)
        let status = passwordBytes.withUnsafeBytes { passwordBuffer in
            salt.withUnsafeBytes { saltBuffer in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), passwordBuffer.baseAddress?.assumingMemoryBound(to: Int8.self), passwordBytes.count,
                                    saltBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count,
                                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 600_000, &derived, derived.count)
            }
        }
        guard status == kCCSuccess else { throw PilotError("Could not derive the recovery encryption key.") }
        defer { _ = derived.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
        return SymmetricKey(data: derived)
    }
    static func encrypt(_ plaintext: Data, password: String) throws -> Data {
        guard password.count >= 12 else { throw PilotError("Use a recovery password with at least 12 characters.") }
        var salt = Data(count: 32)
        let result = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard result == errSecSuccess else { throw PilotError("Could not generate a recovery salt.") }
        let sealed = try AES.GCM.seal(plaintext, using: key(password: password, salt: salt), authenticating: magic + salt)
        guard let combined = sealed.combined else { throw PilotError("Could not encrypt recovery backup.") }
        return magic + salt + combined
    }
    static func decrypt(_ data: Data, password: String) throws -> Data {
        guard data.count <= 384 * 1024 * 1024, data.starts(with: magic), data.count >= magic.count + 32 + 28 else { throw PilotError("This is not a supported encrypted FalconDeck recovery backup.") }
        let salt = data.subdata(in: magic.count..<(magic.count + 32))
        do {
            return try AES.GCM.open(AES.GCM.SealedBox(combined: data.dropFirst(magic.count + 32)), using: key(password: password, salt: salt), authenticating: magic + salt)
        } catch { throw PilotError("The recovery password is incorrect or the backup is damaged.") }
    }
}

@MainActor @Observable final class NativeRecovery {
    static let shared = NativeRecovery()
    var folder: String { didSet { defaults.set(folder, forKey: prefix + "folder") } }
    var daily: Bool { didSet { defaults.set(daily, forKey: prefix + "daily") } }
    var lastSuccess: Date? { didSet { defaults.set(lastSuccess, forKey: prefix + "success") } }
    var lastError: String? { didSet { defaults.set(lastError, forKey: prefix + "error") } }
    var busy = false
    var message: String?
    private let defaults = UserDefaults.standard
    private let prefix = "falcondeck.recovery."
    private var timer: Task<Void, Never>?
    private var lastAttempt = Date.distantPast
    init() {
        let d = UserDefaults.standard
        folder = d.string(forKey: "falcondeck.recovery.folder") ?? ""
        daily = d.bool(forKey: "falcondeck.recovery.daily")
        lastSuccess = d.object(forKey: "falcondeck.recovery.success") as? Date
        lastError = d.string(forKey: "falcondeck.recovery.error")
    }
    func attach(store: AppStore) {
        guard timer == nil else { return }
        timer = Task { [weak self, weak store] in
            while !Task.isCancelled {
                if let self, let store, self.daily, !self.busy, store.isConnected,
                   Date().timeIntervalSince(self.lastSuccess ?? .distantPast) >= 86400,
                   Date().timeIntervalSince(self.lastAttempt) >= 3600 {
                    self.lastAttempt = .now
                    do { guard let password = try self.savedPassword() else { throw PilotError("Enter your recovery password again to resume daily backups.") }; try await self.backup(store: store, password: password) }
                    catch { self.lastError = error.localizedDescription }
                }
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }
    private var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.falcondeck.recovery.v1", kSecAttrAccount as String: "daily-password"]
    }
    func savePassword(_ password: String) throws {
        guard password.count >= 12 else { throw PilotError("Use at least 12 characters for the recovery password.") }
        let attrs: [String: Any] = [kSecValueData as String: Data(password.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(keychainQuery as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(keychainQuery.merging(attrs) { _, value in value } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw PilotError("Could not store the daily backup password in Keychain (\(status)).") }
    }
    private func savedPassword() throws -> String? {
        var query = keychainQuery; query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = result as? Data else { throw PilotError("Could not unlock the daily backup password (\(status)).") }
        return String(data: bytes, encoding: .utf8)
    }
    func backup(store: AppStore, password: String) async throws {
        guard !busy, !folder.isEmpty else { throw PilotError("Choose a recovery backup folder first.") }
        busy = true; message = nil
        defer { busy = false }
        do {
            let snapshot = try await store.request("/api/recovery")
                .setting("client", NativeArchivePreferences.clientBackup(NativePreferences.shared.exportSettings()))
            let destinationFolder = URL(fileURLWithPath: folder, isDirectory: true).resolvingSymlinksInPath().path
            let source = URL(fileURLWithPath: snapshot["source_state"].string, isDirectory: true).resolvingSymlinksInPath().path
            guard destinationFolder != source, !destinationFolder.hasPrefix(source + "/") else {
                throw PilotError("Choose a backup folder outside FalconDeck’s own data directory.")
            }
            let data = try JSONEncoder().encode(snapshot)
            let destination = URL(fileURLWithPath: folder, isDirectory: true).appendingPathComponent("falcondeck-recovery-\(UUID().uuidString).fdbackup")
            try await Task.detached(priority: .utility) {
                try NativeArchiveFile.write(NativeRecoveryCrypto.encrypt(data, password: password), to: destination)
            }.value
            if daily { try savePassword(password) }
            lastSuccess = .now; lastError = nil
            message = "Encrypted backup saved: \(destination.lastPathComponent). Cloud upload is managed by your sync provider."
        } catch { lastError = error.localizedDescription; throw error }
    }
}

struct NativeRecoverySettings: View {
    let store: AppStore
    @Bindable private var recovery = NativeRecovery.shared
    @State private var password = ""
    @State private var confirmation = ""
    @State private var candidate: JSON?
    @State private var filename = ""
    @State private var error: String?
    @State private var inspecting = false
    var body: some View {
        Section {
            LabeledContent("Destination", value: recovery.folder.isEmpty ? "Not selected" : recovery.folder)
            Button("Choose backup folder…") {
                let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
                if panel.runModal() == .OK, let url = panel.url { recovery.folder = url.path }
            }.disabled(recovery.busy)
            SecureField("Recovery password", text: $password)
            SecureField("Confirm password for new backups", text: $confirmation)
            Text("Use at least 12 characters and keep this password in your password manager. It is required on a replacement Mac. Choose a folder in iCloud Drive or another backed-up location.")
                .font(.caption).foregroundStyle(.secondary)
            Toggle("Back up daily while FalconDeck is open", isOn: Binding(get: { recovery.daily }, set: { enabled in
                if !enabled { recovery.daily = false; return }
                do { try validatePassword(); try recovery.savePassword(password); recovery.daily = true; error = nil }
                catch { self.error = error.localizedDescription }
            })).disabled(recovery.busy)
            Button(recovery.busy ? "Backing up…" : "Back up now") {
                Task { do { try validatePassword(); try await recovery.backup(store: store, password: password); password = ""; confirmation = ""; error = nil } catch { self.error = error.localizedDescription } }
            }.disabled(recovery.busy || !store.isConnected)
            if let date = recovery.lastSuccess { LabeledContent("Last saved locally", value: date.formatted()) }
            if let problem = recovery.lastError { Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
            if let message = recovery.message { Text(message).textSelection(.enabled) }
            Text("Includes Claude and Codex bot sessions, bot documents, attached context files, managed attachments, settings and automations. Agent sign-ins, pairings, caches, project repositories and ordinary task history are excluded. Backups are encrypted with AES-256-GCM and a password-derived key. Existing backup files are retained.")
                .font(.caption).foregroundStyle(.secondary)
        } header: { Text("Encrypted recovery backup") }
        Section {
            if let candidate {
                LabeledContent("Backup", value: filename)
                LabeledContent("Bots", value: "\(candidate["bot_count"].int)")
                LabeledContent("Files", value: "\(candidate["files"].array.count)")
                Text("Restoring requires a fresh instance with no projects or bots. Files will be installed when you quit and reopen FalconDeck. Automations will be paused. Sign in to your agents and pair devices again afterwards.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Cancel") { self.candidate = nil }
                    Button("Restore on next launch") { Task {
                        do {
                            _ = try await store.request("/api/recovery/stage", method: "POST", body: candidate)
                            NativePreferences.shared.importSettings(NativeArchivePreferences.nativeSettings(candidate["client"]))
                            self.candidate = nil; password = ""; confirmation = ""
                            recovery.message = "Recovery is ready. Quit and reopen FalconDeck to finish."
                            recovery.daily = false; error = nil
                        } catch { self.error = error.localizedDescription }
                    } }.buttonStyle(.borderedProminent)
                }
            } else {
                Button(inspecting ? "Unlocking…" : "Open encrypted recovery backup…") { Task { await inspect() } }.disabled(inspecting || recovery.busy || !store.isConnected)
                Text("Enter the backup’s recovery password above, then select its .fdbackup file to preview it.").font(.caption).foregroundStyle(.secondary)
            }
            if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
        } header: { Text("Recover on a replacement Mac") }
    }
    private func validatePassword() throws {
        guard password.count >= 12, password == confirmation else { throw PilotError("Enter matching recovery passwords with at least 12 characters.") }
    }
    @MainActor private func inspect() async {
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        inspecting = true; defer { inspecting = false }
        do {
            let secret = password
            let bytes = try await Task.detached(priority: .utility) {
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 384 * 1024 * 1024 else { throw PilotError("Recovery backup exceeds the 384 MB import limit.") }
                return try NativeRecoveryCrypto.decrypt(Data(contentsOf: url), password: secret)
            }.value
            let decoded = try JSON.decode(bytes)
            guard decoded["version"].int == 1, case .array = decoded["files"] else { throw PilotError("Unsupported recovery archive.") }
            candidate = decoded; filename = url.lastPathComponent; error = nil
        } catch { self.error = error.localizedDescription; candidate = nil }
    }
}
