import Foundation

struct NativePairingInput: Sendable {
    static let defaultRelay = "https://connect.falcondeck.com"
    let relay: URL
    let code: String
    let authoritySeed: Data

    init(text: String, relay: String) throws {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var rawCode = text
        var rawRelay = relay
        if let link = URLComponents(string: text), let scheme = link.scheme {
            let isPairingPage = link.path == "/pair" ||
                (link.host == "app.falcondeck.com" && ["", "/"].contains(link.path))
            guard ["https", "falcondeck", "falcondeck-native"].contains(scheme),
                  (scheme != "https" || isPairingPage) else { throw PilotError("Paste a pairing link or the complete secure code.") }
            rawCode = link.queryItems?.first(where: { $0.name == "code" })?.value ?? ""
            rawRelay = link.queryItems?.first(where: { $0.name == "relay" })?.value ?? relay
        }
        self.relay = try Self.relayURL(rawRelay)
        let parts = rawCode.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { throw PilotError("Use the full secure pairing link from your computer.") }
        code = parts[0].uppercased()
        var seed = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        seed += String(repeating: "=", count: (4 - seed.count % 4) % 4)
        guard let bytes = Data(base64Encoded: seed), bytes.count == 32 else { throw PilotError("The secure pairing code is incomplete.") }
        authoritySeed = bytes
    }

    static func relayURL(_ text: String) throws -> URL {
        guard var c = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = c.host, !host.isEmpty,
              c.scheme == "https" || (c.scheme == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(host)),
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil else {
            throw PilotError("Use an HTTPS relay address. HTTP is supported only on localhost.")
        }
        while c.path.hasSuffix("/") { c.path.removeLast() }
        guard let url = c.url else { throw PilotError("The relay address is invalid.") }
        return url
    }
}
