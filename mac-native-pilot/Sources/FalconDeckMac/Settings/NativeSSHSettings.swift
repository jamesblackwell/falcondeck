import Foundation

/// SSH aliases keep their effective configuration, including Host/Match blocks.
enum NativeSSHSettings {
    static func port(mode: String, text: String) throws -> Int? {
        guard mode != "ssh" else { return nil }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        guard let port = Int(value), (1...65535).contains(port) else {
            throw PilotError("Enter an SSH port between 1 and 65535.")
        }
        return port
    }

    static func fields(target: String, port: Int?) -> [String: JSON] {
        var fields: [String: JSON] = ["ssh_target": .string(target)]
        if let port { fields["port"] = .number(Double(port)) }
        return fields
    }
}
