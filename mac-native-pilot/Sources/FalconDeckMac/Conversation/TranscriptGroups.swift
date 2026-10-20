import Foundation

/// Stable ordered groups. Only activity folds together; messages, approvals,
/// artifacts and changes keep their own selectable transcript rows.
enum ConversationTranscriptGroups {
    static func groups(messages: [Message], preferences source: JSON, thinkingDisplay: String? = nil) -> [[Message]] {
        var preferences = TranscriptPresentation.conversationPreferences(source)
        if let thinkingDisplay { preferences = preferences.setting("thinking_display", .string(thinkingDisplay)) }
        let mode = TranscriptPresentation.toolMode(preferences)
        guard mode != "expanded" else { return messages.map { [$0] } }
        var result: [[Message]] = [], pending: [Message] = []
        func flush() {
            if !pending.isEmpty { result.append(pending); pending.removeAll(keepingCapacity: true) }
        }
        for (index, original) in messages.enumerated() {
            var message = original
            // Only the trailing reasoning item can still be receiving text.
            // Providers sometimes omit a final lifecycle update when a tool
            // immediately follows the thought.
            if message.kind == "reasoning", message.streaming, index < messages.count - 1 {
                message.raw = message.raw.setting("lifecycle", .string("complete"))
            }
            if message.kind == "reasoning", mode == "collapsed", !pending.isEmpty,
               preferences["thinking_display"].string != "preview",
               !TranscriptPresentation.defaultExpanded(message, preferences: preferences) {
                pending.append(message)
                continue
            }
            let tool = message.kind == "tool_call"
            let signal = TranscriptPresentation.hasRenderableArtifacts(message.raw)
                || TranscriptPresentation.isApproval(message.raw) && TranscriptPresentation.autoExpand("approvals", preferences: preferences)
                || message.raw["display"]["artifact_kind"].string == "diff"
                || TranscriptPresentation.failedTests(message.raw) && TranscriptPresentation.autoExpand("failed_tests", preferences: preferences)
                || mode != "collapsed" && TranscriptPresentation.defaultExpanded(message, preferences: preferences)
            let mayGroup = tool && !signal && (mode == "collapsed"
                || TranscriptPresentation.flag("group_read_only_tools", preferences: preferences) && TranscriptPresentation.isReadOnly(message.raw))
            if mayGroup { pending.append(message) }
            else { flush(); result.append([message]) }
        }
        flush()
        return result
    }

    static func firstDiffItemID(messages: [Message]) -> String? {
        messages.first {
            ["diff", "file_change"].contains($0.kind) ||
                $0.kind == "tool_call" && $0.raw["display"]["artifact_kind"].string == "diff"
        }?.id
    }

    static func showsExpansionControls(preferences: JSON) -> Bool {
        TranscriptPresentation.flag("show_expand_all_controls", preferences: preferences)
    }

    static func title(for messages: [Message]) -> String {
        let tools = messages.filter { $0.kind == "tool_call" }
        let running = tools.contains { $0.running }
        let label = tools.allSatisfy { TranscriptPresentation.isReadOnly($0.raw) } ? "Explored" : "Worked"
        return "\(running ? "Working" : label) · \(tools.count) \(tools.count == 1 ? "step" : "steps")"
    }
}

struct TranscriptFileLink: Equatable {
    let path: String
    let line: Int?

    /// Local Markdown destinations are handled by the native file inspector,
    /// never sent to the system as arbitrary URL schemes.
    static func parse(_ value: String) -> Self? {
        guard !value.isEmpty, !value.hasPrefix("#"), !value.hasPrefix("//"),
              !value.contains("\0") else { return nil }
        // Foundation treats `README.md:12` as a URI scheme. An explicit
        // filename plus source line is a relative file destination instead.
        let relativeLine = value.range(of: #"^[^/:?#]+\.[^/:?#]+:[1-9][0-9]*(?::[1-9][0-9]*)?(?:#.*)?$"#, options: .regularExpression) != nil
        guard let url = URL(string: relativeLine ? "./" + value : value) else { return nil }
        let scheme = url.scheme?.lowercased()
        guard scheme == nil || scheme == "file", url.user == nil, url.password == nil,
              url.host == nil || url.host == "" || url.host == "localhost" else { return nil }
        var path = url.path
        guard !path.isEmpty, !path.hasPrefix("//") else { return nil }
        var line: Int?
        if let fragment = url.fragment {
            let number = fragment.drop { $0 == "L" || $0 == "l" }.prefix { $0.isNumber }
            if let value = Int(number), value > 0 { line = value }
        }
        if line == nil, let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let rawLine = components.queryItems?.first(where: { $0.name == "line" })?.value,
           let value = Int(rawLine), value > 0 { line = value }
        if let match = path.range(of: #":([1-9][0-9]*)(?::[1-9][0-9]*)?$"#, options: .regularExpression) {
            let suffix = path[match].dropFirst().split(separator: ":").first
            if line == nil, let suffix { line = Int(suffix) }
            path.removeSubrange(match)
        }
        guard !path.isEmpty else { return nil }
        // Absolute paths and explicit relative file paths are supported. A bare
        // word such as "settings" is not silently interpreted as a local file.
        guard path.hasPrefix("/") || path.hasPrefix("./") || path.hasPrefix("../") || path.hasPrefix("~/") || path.contains("/") || path.contains(".") else { return nil }
        return Self(path: path, line: line)
    }
}
