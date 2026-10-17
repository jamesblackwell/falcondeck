import CryptoKit
import Foundation
import Sodium

struct RelayIdentity: Sendable {
    let secret: Data
    init(secret: Data? = nil) throws {
        self.secret = secret ?? Curve25519.KeyAgreement.PrivateKey().rawRepresentation
        guard self.secret.count == 32 else { throw PilotError("Invalid device identity.") }
    }
    var publicKey: String { get throws { try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret).publicKey.rawRepresentation.base64EncodedString() } }
    var signingKey: Curve25519.Signing.PrivateKey { get throws { try .init(rawRepresentation: secret) } }
    var identityKey: String { get throws { try signingKey.publicKey.rawRepresentation.base64EncodedString() } }
    func sign(_ lines: [String]) throws -> String {
        try signingKey.signature(for: Data(lines.joined(separator: "\n").utf8)).base64EncodedString()
    }
    func bundle() throws -> JSON {
        let pub = try publicKey, identity = try identityKey
        return .object([
            "encryption_variant": .string("data_key_v1"), "identity_variant": .string("ed25519_v1"),
            "public_key": .string(pub), "identity_public_key": .string(identity),
            "signature": .string(try sign(["falcondeck-pairing-bundle-v1", "data_key_v1", "ed25519_v1", pub, identity]))
        ])
    }
}

enum RelayCrypto {
    static func verify(signature: String, key: String, lines: [String]) throws {
        guard let sig = Data(base64Encoded: signature), sig.count == 64,
              let bytes = Data(base64Encoded: key), bytes.count == 32,
              let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: bytes),
              pub.isValidSignature(sig, for: Data(lines.joined(separator: "\n").utf8)) else {
            throw PilotError("Could not verify this computer’s identity. Create a fresh pairing link.")
        }
    }

    static func verifyClaim(_ claim: JSON, input: PairingInput) throws {
        let b = claim["daemon_bundle"], a = claim["pairing_authority"]
        guard b["encryption_variant"].string == "data_key_v1", b["identity_variant"].string == "ed25519_v1",
              Data(base64Encoded: b["public_key"].string)?.count == 32 else { throw PilotError("Unsupported computer key bundle.") }
        try verify(signature: b["signature"].string, key: b["identity_public_key"].string,
                   lines: ["falcondeck-pairing-bundle-v1", "data_key_v1", "ed25519_v1", b["public_key"].string, b["identity_public_key"].string])
        let authorityKey = try Curve25519.Signing.PrivateKey(rawRepresentation: input.authoritySeed).publicKey.rawRepresentation.base64EncodedString()
        guard a["public_key"].string == authorityKey else { throw PilotError("The pairing link does not match this computer.") }
        try verify(signature: a["daemon_bundle_signature"].string, key: authorityKey,
                   lines: ["falcondeck-pairing-authority-daemon-v1", authorityKey, "data_key_v1", "ed25519_v1", b["public_key"].string, b["identity_public_key"].string])
    }

    static func bootstrap(_ m: JSON, session: SavedSession) throws -> Data {
        let identity = try RelayIdentity(secret: session.secret)
        guard m["encryption_variant"].string == "data_key_v1", m["identity_variant"].string == "ed25519_v1",
              m["session_id"].string == session.sessionID,
              m["daemon_public_key"].string == session.daemonKey,
              m["daemon_identity_public_key"].string == session.daemonIdentity,
              m["client_public_key"].string == (try identity.publicKey),
              m["client_identity_public_key"].string == (try identity.identityKey) else { throw PilotError("The encrypted session is addressed to another device.") }
        try verify(signature: m["signature"].string, key: session.daemonIdentity, lines: [
            "falcondeck-session-bootstrap-v1", "data_key_v1", "ed25519_v1", m["pairing_id"].string,
            session.sessionID, session.daemonKey, session.daemonIdentity, try identity.publicKey, try identity.identityKey,
            m["client_wrapped_data_key"]["wrapped_key"].string, m["daemon_wrapped_data_key"]["wrapped_key"].string
        ])
        guard m["client_wrapped_data_key"]["encryption_variant"].string == "data_key_v1",
              let bytes = Data(base64Encoded: m["client_wrapped_data_key"]["wrapped_key"].string), bytes.count == 105, bytes.first == 0,
              let key = Sodium().box.open(nonceAndAuthenticatedCipherText: Array(bytes.dropFirst(33)),
                                          senderPublicKey: Array(bytes[1..<33]), recipientSecretKey: Array(session.secret)), key.count == 32 else {
            throw PilotError("Could not open the encrypted session key.")
        }
        return Data(key)
    }

    static func encrypt(_ value: JSON, key: Data) throws -> JSON {
        guard key.count == 32 else { throw PilotError("Invalid encryption key.") }
        let box = try AES.GCM.seal(value.data(), using: SymmetricKey(data: key))
        guard let combined = box.combined else { throw PilotError("Could not encrypt request.") }
        return .object(["encryption_variant": .string("data_key_v1"), "ciphertext": .string((Data([0]) + combined).base64EncodedString())])
    }
    static func decrypt(_ envelope: JSON, key: Data) throws -> JSON {
        guard key.count == 32, envelope["encryption_variant"].string == "data_key_v1",
              let bytes = Data(base64Encoded: envelope["ciphertext"].string), bytes.count >= 29, bytes.first == 0 else {
            throw PilotError("Malformed encrypted response.")
        }
        let plaintext = try AES.GCM.open(AES.GCM.SealedBox(combined: bytes.dropFirst()), using: SymmetricKey(data: key))
        return try JSON.decode(plaintext)
    }
}
