import Foundation

/// Stable ordered groups. Only activity folds together; messages, approvals,
/// artifacts and changes keep their own selectable transcript rows.
enum ConversationTranscriptGroups {
    static func groups(messages: [Message], preferences source: JSON, thinkingDisplay: String? = nil, isStreaming: Bool = true) -> [[Message]] {
        var preferences = TranscriptPresentation.conversationPreferences(source)
        if let thinkingDisplay { preferences = preferences.setting("thinking_display", .string(thinkingDisplay)) }
        let mode = TranscriptPresentation.toolMode(preferences)
        // Providers can omit a final lifecycle update before the next item.
        // Settle old thoughts even when tools are shown without grouping.
        let settled = messages.enumerated().map { index, original in
            var message = original
            if message.kind == "reasoning", message.streaming, index < messages.count - 1 || !isStreaming {
                message.raw = message.raw.setting("lifecycle", .string("complete"))
            }
            return message
        }
        let messages = settled
        // Expanded mode shows every item verbatim, including a bare thought.
        guard mode != "expanded" else { return messages.map { [$0] } }
        var result: [[Message]] = [], pending: [Message] = []
        func flush() {
            if !pending.isEmpty { result.append(pending); pending.removeAll(keepingCapacity: true) }
        }
        for message in messages {
            if message.kind == "reasoning", mode == "collapsed", !pending.isEmpty {
                let showBody = TranscriptPresentation.hasReasoningBody(message.raw)
                    && (preferences["thinking_display"].string == "preview"
                        || TranscriptPresentation.defaultExpanded(message, preferences: preferences))
                if !showBody { pending.append(message); continue }
            }
            if mayGroup(message, preferences: preferences) { pending.append(message) }
            else { flush(); result.append([message]) }
        }
        flush()
        // A thought absorbed into a burst still reads as part of that work. One
        // left on its own would draw a bare "Thought" line instead. If that is
        // the whole turn, keep it: an empty transcript would look like loss.
        let kept = result.filter { !($0.count == 1 && isEmptyThought($0[0])) }
        return kept.isEmpty ? result : kept
    }

    /// A settled thought with no summary and no retained body draws a bare
    /// "Thought" line that says nothing and cannot be opened. An interrupted or
    /// failed thought still reports something, so it stays.
    static func isEmptyThought(_ message: Message) -> Bool {
        guard message.kind == "reasoning", !message.streaming,
              !["interrupted", "error"].contains(message.raw["lifecycle"].string) else { return false }
        return message.raw["summary"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !TranscriptPresentation.hasReasoningBody(message.raw)
    }

    /// Collapsed mode folds even one routine tool. Group size must not decide
    /// whether a command appears as a full card or a quiet work receipt.
    static func isActivityGroup(_ messages: [Message], preferences: JSON) -> Bool {
        messages.count > 1 || messages.first.map {
            TranscriptPresentation.toolMode(preferences) == "collapsed" && mayGroup($0, preferences: preferences)
        } == true
    }

    private static func mayGroup(_ message: Message, preferences: JSON) -> Bool {
        guard message.kind == "tool_call" else { return false }
        let mode = TranscriptPresentation.toolMode(preferences)
        let signal = TranscriptPresentation.hasRenderableArtifacts(message.raw)
            || TranscriptPresentation.isApproval(message.raw) && TranscriptPresentation.autoExpand("approvals", preferences: preferences)
            || message.raw["display"]["artifact_kind"].string == "diff"
            || TranscriptPresentation.failedTests(message.raw) && TranscriptPresentation.autoExpand("failed_tests", preferences: preferences)
            || mode != "collapsed" && TranscriptPresentation.defaultExpanded(message, preferences: preferences)
        return !signal && (mode == "collapsed"
            || TranscriptPresentation.flag("group_read_only_tools", preferences: preferences) && TranscriptPresentation.isReadOnly(message.raw))
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

    static func isRunning(_ messages: [Message], keepAlive: Bool = false) -> Bool {
        keepAlive || messages.contains { $0.running }
    }

    static func title(for messages: [Message], running: Bool = false) -> String {
        let tools = messages.filter { $0.kind == "tool_call" }
        if isRunning(messages, keepAlive: running) {
            return messages.last?.kind == "reasoning" && !tools.contains(where: { $0.running }) ? "Thinking…" : "Working…"
        }
        let label = tools.allSatisfy { TranscriptPresentation.isReadOnly($0.raw) } ? "Explored" : "Worked"
        return "\(label) · \(tools.count) \(tools.count == 1 ? "step" : "steps")"
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
        let relativeLine = value.range(of: #"^[^/:?#]+\.[^/:?#]+:[1-9][0-9]*(?::[1-9][0-9]*)?(?:\?[^#]*)?(?:#.*)?$"#, options: .regularExpression) != nil
        guard let url = URL(string: relativeLine ? "./" + value : value) else { return nil }
        let scheme = url.scheme?.lowercased()
        guard scheme == nil || scheme == "file", url.user == nil, url.password == nil,
              url.host == nil || url.host == "" || url.host == "localhost" else { return nil }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        // Source locations use literal colons; an encoded colon belongs to the
        // filename and must survive suffix parsing before the path is decoded.
        var path = components.percentEncodedPath
        var line: Int?
        if let fragment = url.fragment {
            let number = fragment.drop { $0 == "L" || $0 == "l" }.prefix { $0.isNumber }
            if let value = Int(number), value > 0 { line = value }
        }
        if line == nil, let rawLine = components.queryItems?.first(where: { $0.name == "line" })?.value,
           let value = Int(rawLine), value > 0 { line = value }
        if let match = path.range(of: #":([1-9][0-9]*)(?::[1-9][0-9]*)?$"#, options: .regularExpression) {
            let suffix = path[match].dropFirst().split(separator: ":").first
            if line == nil, let suffix { line = Int(suffix) }
            path.removeSubrange(match)
        }
        guard let path = path.removingPercentEncoding, !path.isEmpty, !path.hasPrefix("//"), !path.contains("\0") else { return nil }
        // Absolute paths and explicit relative file paths are supported. A bare
        // word such as "settings" is not silently interpreted as a local file.
        guard path.hasPrefix("/") || path.hasPrefix("./") || path.hasPrefix("../") || path.hasPrefix("~/") || path.contains("/") || path.contains(".") else { return nil }
        return Self(path: path, line: line)
    }
}
