import Foundation
import XCTest
@testable import FalconDeckMac

final class RecoveryTests: XCTestCase {
    func testRecoveryEncryptionRoundTripAndRandomness() throws {
        let payload = Data("bot transcript and private memory".utf8)
        let first = try NativeRecoveryCrypto.encrypt(payload, password: "a recovery password")
        let second = try NativeRecoveryCrypto.encrypt(payload, password: "a recovery password")
        XCTAssertNotEqual(first, second)
        XCTAssertNil(String(data: first, encoding: .utf8))
        XCTAssertEqual(try NativeRecoveryCrypto.decrypt(first, password: "a recovery password"), payload)
    }
    func testWrongPasswordAndTamperingAreRejected() throws {
        let encrypted = try NativeRecoveryCrypto.encrypt(Data("private bot documents".utf8), password: "a recovery password")
        XCTAssertThrowsError(try NativeRecoveryCrypto.decrypt(encrypted, password: "a different password"))
        var changed = encrypted
        changed[changed.count - 1] ^= 1
        XCTAssertThrowsError(try NativeRecoveryCrypto.decrypt(changed, password: "a recovery password"))
        changed = encrypted; changed[12] ^= 1
        XCTAssertThrowsError(try NativeRecoveryCrypto.decrypt(changed, password: "a recovery password"))
        XCTAssertThrowsError(try NativeRecoveryCrypto.decrypt(Data("{}".utf8), password: "a recovery password"))
        XCTAssertThrowsError(try NativeRecoveryCrypto.encrypt(Data(), password: "short"))
    }
}
