import CryptoKit
import Foundation
import Sodium
import XCTest
@testable import FalconDeckNative

final class ProtocolTests: XCTestCase {
    func testTypeScriptAESWireCompatibilityAndTamperRejection() throws {
        // Public synthetic fixture: @noble/ciphers AES-GCM, key=42, nonce=7.
        let ciphertext = "AAcHBwcHBwcHBwcHB0TdjMog5kZU23BS1POM0khZ9AQD6h9MF9pI7f05X3Zh3JbAZnCRlHjrxIqX3ZJHAwFbqqM="
        let key = Data(repeating: 42, count: 32)
        let envelope = JSON.object(["encryption_variant": .string("data_key_v1"), "ciphertext": .string(ciphertext)])
        let decoded = try RelayCrypto.decrypt(envelope, key: key)
        XCTAssertEqual(decoded["source"].string, "typescript")
        XCTAssertEqual(decoded["projects"].int, 4)
        var corrupt = Data(base64Encoded: ciphertext)!
        corrupt[20] ^= 1
        XCTAssertThrowsError(try RelayCrypto.decrypt(.object(["encryption_variant": .string("data_key_v1"), "ciphertext": .string(corrupt.base64EncodedString())]), key: key))
        XCTAssertEqual(try RelayCrypto.decrypt(RelayCrypto.encrypt(decoded, key: key), key: key), decoded)
    }

    func testSecurePairingPreservesAuthorityCaseAndRejectsUnsafeRelays() throws {
        let seed = Data((0..<32).map(UInt8.init)).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let input = try PairingInput(text: "falcondeck-native://pair?code=abc123.\(seed)", relay: "https://connect.falcondeck.com/")
        XCTAssertEqual(input.code, "ABC123")
        XCTAssertEqual(input.authoritySeed, Data((0..<32).map(UInt8.init)))
        XCTAssertEqual(input.relay.absoluteString, "https://connect.falcondeck.com")
        XCTAssertThrowsError(try PairingInput(text: "ABC123", relay: "https://connect.falcondeck.com"))
        for url in ["http://evil.example", "https://name:password@example.com", "https://example.com?token=x", "https://example.com#x", "file:///tmp/relay"] {
            XCTAssertThrowsError(try PairingInput.relayURL(url))
        }
        XCTAssertNoThrow(try PairingInput.relayURL("http://127.0.0.1:9000"))
    }

    func testBundleAndAuthoritySignaturesCannotBeSubstituted() throws {
        let daemon = try RelayIdentity()
        let authority = try RelayIdentity()
        let bundle = try daemon.bundle()
        let input = try PairingInput(text: "ABC.\(authority.secret.base64EncodedString())", relay: "https://connect.falcondeck.com")
        let signature = try authority.sign(["falcondeck-pairing-authority-daemon-v1", try authority.identityKey, "data_key_v1", "ed25519_v1", try daemon.publicKey, try daemon.identityKey])
        let claim = JSON.object(["daemon_bundle": bundle, "pairing_authority": .object(["public_key": .string(try authority.identityKey), "daemon_bundle_signature": .string(signature)])])
        XCTAssertNoThrow(try RelayCrypto.verifyClaim(claim, input: input))
        let wrong = try PairingInput(text: "ABC.\(RelayIdentity().secret.base64EncodedString())", relay: "https://connect.falcondeck.com")
        XCTAssertThrowsError(try RelayCrypto.verifyClaim(claim, input: wrong))
    }

    func testBootstrapUnwrapsNaClKeyAndPinsClientAndComputer() throws {
        let client = try RelayIdentity(), daemon = try RelayIdentity(), ephemeral = try RelayIdentity()
        let key = Data(repeating: 42, count: 32)
        let sealed: [UInt8] = try XCTUnwrap(Sodium().box.seal(message: Array(key), recipientPublicKey: Array(Data(base64Encoded: client.publicKey)!), senderSecretKey: Array(ephemeral.secret)))
        let wrapped = (Data([0]) + Data(base64Encoded: try ephemeral.publicKey)! + Data(sealed)).base64EncodedString()
        let lines = ["falcondeck-session-bootstrap-v1", "data_key_v1", "ed25519_v1", "pairing", "session", try daemon.publicKey, try daemon.identityKey, try client.publicKey, try client.identityKey, wrapped, ""]
        let material = JSON.object([
            "encryption_variant": .string("data_key_v1"), "identity_variant": .string("ed25519_v1"),
            "pairing_id": .string("pairing"), "session_id": .string("session"),
            "daemon_public_key": .string(try daemon.publicKey), "daemon_identity_public_key": .string(try daemon.identityKey),
            "client_public_key": .string(try client.publicKey), "client_identity_public_key": .string(try client.identityKey),
            "client_wrapped_data_key": .object(["encryption_variant": .string("data_key_v1"), "wrapped_key": .string(wrapped)]),
            "signature": .string(try daemon.sign(lines))
        ])
        let session = SavedSession(relay: URL(string: "https://connect.falcondeck.com")!, sessionID: "session", deviceID: "test-device", token: "synthetic-fixture", secret: client.secret, daemonKey: try daemon.publicKey, daemonIdentity: try daemon.identityKey)
        XCTAssertEqual(try RelayCrypto.bootstrap(material, session: session), key)
        let otherClient = SavedSession(relay: session.relay, sessionID: session.sessionID, deviceID: session.deviceID, token: session.token, secret: try RelayIdentity().secret, daemonKey: session.daemonKey, daemonIdentity: session.daemonIdentity)
        XCTAssertThrowsError(try RelayCrypto.bootstrap(material, session: otherClient))
    }

    func testChunkReassemblyAndOrderingAndWirePrefix() throws {
        var receiver = ChunkReceiver()
        let first = Data(repeating: 65, count: 11 * 1024), last = Data("tail".utf8)
        func chunk(_ index: Int, _ part: Data) -> JSON {
            .object(["type": .string("transport-chunk"), "id": .number(1), "index": .number(Double(index)), "total": .number(Double(first.count + last.count)), "data": .string(part.base64EncodedString())])
        }
        XCTAssertNil(try receiver.receive(chunk(0, first)))
        XCTAssertEqual(try receiver.receive(chunk(1, last)), first + last)
        XCTAssertThrowsError(try receiver.receive(chunk(1, last)))
        let ack = JSON.object(["type": .string("transport-ack"), "id": .number(1), "index": .number(0)])
        XCTAssertTrue(try ack.wireText().hasPrefix("{\"type\":\"transport-ack\""))
        XCTAssertEqual(try JSON.decode(Data(ack.wireText().utf8)), ack)
    }
}
