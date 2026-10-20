import Foundation
import XCTest
@testable import FalconDeckMac

final class NativePairingInputTests: XCTestCase {
    func testOfficialRootPairingLinksPreserveSecureGrantAndRelay() throws {
        let authority = Data((0..<32).map(UInt8.init))
        let seed = authority.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        for path in ["", "/", "/pair"] {
            let input = try NativePairingInput(
                text: "https://app.falcondeck.com\(path)?code=abc123.\(seed)&relay=https%3A%2F%2Frelay.example.com",
                relay: NativePairingInput.defaultRelay
            )
            XCTAssertEqual(input.code, "ABC123")
            XCTAssertEqual(input.authoritySeed, authority)
            XCTAssertEqual(input.relay.absoluteString, "https://relay.example.com")
        }
        XCTAssertThrowsError(try NativePairingInput(
            text: "https://example.com/?code=abc123.\(seed)",
            relay: NativePairingInput.defaultRelay
        ))
    }
}
