import Foundation

/// Mirrors client-core's harness-user-text projection. Agent scaffolding remains
/// in the source transcript, while the visible transcript shows the typed prompt.
enum UserTextProjection {
    enum Result: Equatable { case prompt(String, automated: Bool), service(String), hidden }
    private static let tags = ["environment_context", "recommended_plugins", "user_instructions", "system-reminder", "command-name", "command-message", "local-command-stdout", "INSTRUCTIONS", "task-notification", "user_info", "local-command-caveat"]
    private static let hiddenPrefixes = ["Caveat: The messages below were generated", "# AGENTS.md instructions for", "The following is the Codex agent history", "[Request interrupted"]
    static func project(_ text: String) -> Result {
        var source = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for _ in 0..<100 {
            let wrappers = [("Use the FalconDeck skill defined at ", ". Follow it as the governing skill for this request."), ("Apply the FalconDeck skill named '", "' to this request.")]
            guard let wrapper = wrappers.first(where: { source.hasPrefix($0.0) }) else { break }
            guard let end = source.range(of: wrapper.1, range: source.index(source.startIndex, offsetBy: wrapper.0.count)..<source.endIndex) else { return .hidden }
            source = String(source[end.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        for tag in tags + ["user_query"] {
            var rest = source[...]
            while let open = rest.range(of: "<\(tag)>") {
                guard let close = rest.range(of: "</\(tag)>", range: open.upperBound..<rest.endIndex) else { return .hidden }
                rest = rest[close.upperBound...]
            }
            if let dangling = source.range(of: "<\(tag)", options: .backwards), !source[dangling.lowerBound...].contains(">") { return .hidden }
        }
        if let query = inner(source, tag: "user_query") { return prompt(query) }
        var remainder = source
        for tag in tags {
            while let open = remainder.range(of: "<\(tag)>"), let close = remainder.range(of: "</\(tag)>", range: open.upperBound..<remainder.endIndex) {
                remainder.removeSubrange(open.lowerBound..<close.upperBound)
            }
        }
        remainder = remainder.trimmingCharacters(in: .whitespacesAndNewlines)
        if !remainder.isEmpty { return prompt(remainder) }
        if source.contains("FalconDeck resume:") { return .service("Resumed after FalconDeck closed") }
        let pattern = #"Background task "[^"]+" completed \(exit code: (-?\d+)\)\."#
        if let match = source.range(of: pattern, options: [.regularExpression, .caseInsensitive]) {
            let receipt = String(source[match])
            let code = receipt.range(of: #"-?\d+(?=\)\.)"#, options: .regularExpression).flatMap { Int(receipt[$0]) } ?? 0
            let command = source.range(of: #"(?i)Command:\s*[^\n]+"#, options: .regularExpression).map { String(source[$0]).replacingOccurrences(of: #"(?i)^Command:\s*"#, with: "", options: .regularExpression) }
            return .service((code == 0 ? "Background command finished" : "Background command failed (exit \(code))") + (command.map { " · " + String($0.prefix(160)) } ?? ""))
        }
        return .hidden
    }
    private static func inner(_ text: String, tag: String) -> String? {
        guard let start = text.range(of: "<\(tag)>"), let end = text.range(of: "</\(tag)>", range: start.upperBound..<text.endIndex) else { return nil }
        return String(text[start.upperBound..<end.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func prompt(_ text: String) -> Result {
        guard !text.isEmpty, !hiddenPrefixes.contains(where: text.hasPrefix) else { return .hidden }
        let automation = "<falcondeck_automation>Sent by scheduled task</falcondeck_automation>"
        if text.hasPrefix(automation) { return .prompt(String(text.dropFirst(automation.count)).trimmingCharacters(in: .whitespacesAndNewlines), automated: true) }
        return .prompt(text, automated: false)
    }
    static func messages(_ items: [Message]) -> [Message] {
        var visible: [Message] = []
        for item in items {
            guard item.kind == "user_message" else { visible.append(item); continue }
            switch project(item.text) {
            case .prompt(let text, let automated):
                let preamble = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
                let hasSkill = preamble.hasPrefix("Use the FalconDeck skill defined at ") || preamble.hasPrefix("Apply the FalconDeck skill named '")
                let previous = visible.reversed().first { !["service", "reasoning", "tool_call"].contains($0.kind) }
                if hasSkill, item.raw["attachments"].array.isEmpty, previous?.kind == "user_message", previous?.text.trimmingCharacters(in: .whitespacesAndNewlines) == text { continue }
                visible.append(Message(item.raw.setting("text", .string(text)).setting("automated", .bool(automated))))
            case .service(let text): visible.append(Message(item.raw.setting("kind", .string("service")).setting("message", .string(text))))
            case .hidden:
                if !item.raw["attachments"].array.isEmpty { visible.append(Message(item.raw.setting("text", .string("")))) }
            }
        }
        return visible
    }
}
