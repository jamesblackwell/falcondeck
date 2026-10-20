import Foundation
import XCTest
@testable import FalconDeckMac

final class NativeSpeechFilePersistenceTests: XCTestCase {
    func testRecoverySaveCreatesItsDestinationAndRestrictsFileAccess() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("speech-persistence-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let destination = root.appendingPathComponent("Voice/transcript-recovery.json")
        try NativeSpeechFiles.save(NativeTranscriptRecovery(text: "Recovered dictation"), at: destination)
        let recovery = try JSONDecoder().decode(NativeTranscriptRecovery.self, from: Data(contentsOf: destination))
        XCTAssertEqual(recovery.text, "Recovered dictation")
        let fileAttributes = try FileManager.default.attributesOfItem(atPath: destination.path)
        XCTAssertEqual((fileAttributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let directoryAttributes = try FileManager.default.attributesOfItem(atPath: destination.deletingLastPathComponent().path)
        XCTAssertEqual((directoryAttributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
    }
}
