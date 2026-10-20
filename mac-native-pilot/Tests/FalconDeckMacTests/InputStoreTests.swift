import CryptoKit
import XCTest
@testable import FalconDeckMac

final class InputStoreTests: XCTestCase {
    func testEncryptedRoundTripRestrictivePermissionsAndStaleRevisionRejection() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-input-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(size: .bits256)
        let store = NativeInputStore(directory: directory, encryptionKey: key)
        let submission = NativePendingSubmission(id: "user-stable", userItemID: "user-stable", sourceKey: "task", composerKey: "task", projectID: "project", threadID: "task", provider: "codex", inputs: [.object(["type": .string("text"), "text": .string("Private prompt")])], settings: ["model_id": .null], draft: "Private prompt", payload: .object([:]), knownQueueIDs: [], status: .uncertain, preserveComposer: true)
        let snapshot = NativeInputSnapshot(drafts: ["task": "Private composer"], payloads: ["task": .object(["quote": .string("Private quote")])], submissions: [submission.id: submission])
        try await store.save(snapshot, revision: 10)
        try await store.save(.init(drafts: ["task": "Stale value"]), revision: 9)
        let file = directory.appendingPathComponent("input.enc")
        let encrypted = try Data(contentsOf: file)
        XCTAssertNil(encrypted.range(of: Data("Private prompt".utf8)))
        XCTAssertNil(encrypted.range(of: Data("Private composer".utf8)))
        let fileMode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)
        let directoryMode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(fileMode.intValue & 0o777, 0o600)
        XCTAssertEqual(directoryMode.intValue & 0o777, 0o700)
        // A new actor models relaunch: ciphertext, rather than in-memory state, owns recovery.
        let relaunched = NativeInputStore(directory: directory, encryptionKey: key)
        let restored = try await relaunched.load()
        XCTAssertEqual(restored.drafts, snapshot.drafts)
        XCTAssertEqual(restored.payloads, snapshot.payloads)
        XCTAssertEqual(restored.submissions, snapshot.submissions)
    }

    func testWrongKeyAndCorruptionRejectRecoveryWithoutReplacingCiphertext() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-input-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(size: .bits256)
        let store = NativeInputStore(directory: directory, encryptionKey: key)
        try await store.save(.init(drafts: ["task": "Keep this recovery copy"]), revision: 1)
        let file = directory.appendingPathComponent("input.enc")
        let encrypted = try Data(contentsOf: file)
        let wrongKeyStore = NativeInputStore(directory: directory, encryptionKey: SymmetricKey(size: .bits256))
        do { _ = try await wrongKeyStore.load(); XCTFail("Recovery with another key must fail") }
        catch { }
        XCTAssertEqual(try Data(contentsOf: file), encrypted)
        var corrupted = encrypted
        corrupted[corrupted.count - 1] ^= 1
        try corrupted.write(to: file)
        do { _ = try await store.load(); XCTFail("Authenticated encryption must reject modified recovery data") }
        catch { }
        XCTAssertEqual(try Data(contentsOf: file), corrupted)
    }
}
