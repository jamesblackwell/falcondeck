import Foundation

/// Forward-compatible presentation helpers shared by transcript cards and media.
enum TranscriptPresentation {
    static func nonempty(_ values: String...) -> String {
        values.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? ""
    }

    /// A summary labels a thought. Only a retained body makes it expandable.
    static func reasoningBody(_ item: JSON) -> String {
        item["content"].string
    }

    static func hasReasoningBody(_ item: JSON) -> Bool {
        !reasoningBody(item).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func reasoningTitle(_ message: Message) -> String {
        if message.streaming { return "Thinking…" }
        let label: String
        switch message.raw["lifecycle"].string {
        case "interrupted": label = "Thought interrupted"
        case "error": label = "Thought failed"
        default: label = nonempty(message.raw["summary"].string.trimmingCharacters(in: .whitespacesAndNewlines), "Thought")
        }
        // A sub-second thought reads as "Thought · 8 ms", which is noise in a
        // stream of them. Only a duration worth noticing earns the suffix.
        guard let milliseconds = message.raw["duration_ms"].optionalInt, milliseconds >= 1000,
              let elapsed = duration(.number(Double(milliseconds))) else { return label }
        return label + " · " + elapsed
    }

    static func isProgressUpdate(_ message: Message) -> Bool {
        message.kind == "assistant_message" && message.raw["phase"].string == "commentary"
    }

    /// Tool output can retain a streaming lifecycle after its command ends.
    /// Follow the indicator the row actually draws, rather than that lifecycle.
    static func hasActivityIndicator(_ message: Message) -> Bool {
        switch message.kind {
        case "assistant_message", "code_review", "reasoning": return message.streaming
        case "tool_call": return message.running
        default: return false
        }
    }

    static func matchesSearch(_ message: Message, query: String) -> Bool {
        !query.isEmpty && (message.text.localizedCaseInsensitiveContains(query)
            || message.title.localizedCaseInsensitiveContains(query))
    }

    static func pretty(_ value: JSON) -> String {
        if case .string(let text) = value { return text }
        guard value != .null, let data = try? value.data(),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]),
              let text = String(data: pretty, encoding: .utf8) else { return "" }
        return text
    }

    static func failure(_ item: JSON) -> Bool {
        if case .number(let exit) = item["exit_code"], exit != 0 { return true }
        return item["display"]["is_error"].bool || ["failed", "error", "denied"].contains(item["status"].string)
            || ["failed", "denied", "interrupted"].contains(item["display"]["lifecycle"].string)
            || item["lifecycle"].string == "error" || !item["error"].string.isEmpty
            || !item["detail"]["error"].string.isEmpty || item["detail"]["success"] == .bool(false)
            || item["detail"]["kind"].string == "guardian_review" && item["detail"]["status"].string == "denied"
    }

    /// Accept a whole daemon preference object or its conversation section.
    static func conversationPreferences(_ preferences: JSON) -> JSON {
        preferences["conversation"] == .null ? preferences : preferences["conversation"]
    }

    static func toolMode(_ preferences: JSON) -> String {
        nonempty(conversationPreferences(preferences)["tool_details_mode"].string, "collapsed")
    }

    static func flag(_ key: String, preferences: JSON) -> Bool {
        conversationPreferences(preferences)[key] != .bool(false)
    }

    static func autoExpand(_ key: String, preferences: JSON) -> Bool {
        conversationPreferences(preferences)["auto_expand"][key] != .bool(false)
    }

    static func isApproval(_ item: JSON) -> Bool {
        item["display"]["artifact_kind"].string == "approval_related" || item["display"]["activity_kind"].string == "approval"
            || ["awaiting_approval", "awaiting_confirmation", "pending_approval"].contains(item["status"].string)
            || item["display"]["lifecycle"].string == "awaiting_approval"
    }

    static func failedTests(_ item: JSON) -> Bool {
        item["display"]["test_summary"]["failed"].int > 0 ||
            item["display"]["artifact_kind"].string == "test" && failure(item)
    }

    static func hasRenderableArtifacts(_ item: JSON) -> Bool {
        let summary = item["display"]["provider_output_summary"]
        if ["images", "audio", "resource_links", "embedded_resources"].contains(where: { summary[$0].int > 0 }) { return true }
        let content = item["detail"]["result"]["content"].array + item["detail"]["content_items"].array
        return content.contains { part in
            ["image", "image_url", "audio", "audio_url", "resource", "resource_link"].contains(nonempty(part["type"].string, part["kind"].string))
        }
    }

    static func isReadOnly(_ item: JSON) -> Bool {
        (item["display"]["is_read_only"].bool || item["display"]["history_mode"].string == "summary")
            && !item["display"]["has_side_effect"].bool
    }

    static func suppressReadOnlyDetails(_ item: JSON, preferences: JSON) -> Bool {
        ["compact", "hide_read_only_details"].contains(toolMode(preferences)) && isReadOnly(item)
            && !hasRenderableArtifacts(item) && !(failure(item) && autoExpand("errors", preferences: preferences))
            && !(failedTests(item) && autoExpand("failed_tests", preferences: preferences))
            && !(isApproval(item) && autoExpand("approvals", preferences: preferences))
    }

    static func defaultExpanded(_ message: Message, preferences source: JSON, firstDiff: Bool = false) -> Bool {
        let preferences = conversationPreferences(source)
        if message.kind == "reasoning" {
            guard hasReasoningBody(message.raw) else { return false }
            switch preferences["thinking_display"].string {
            case "always_expanded": return true
            case "always_collapsed", "preview": return false
            default: return message.streaming
            }
        }
        if message.kind == "tool_call" {
            if toolMode(preferences) == "expanded" { return true }
            if hasRenderableArtifacts(message.raw) { return true }
            if isApproval(message.raw), autoExpand("approvals", preferences: preferences) { return true }
            if failedTests(message.raw), autoExpand("failed_tests", preferences: preferences) { return true }
            if firstDiff, autoExpand("first_diff", preferences: preferences) { return true }
            // Hidden tool mode deliberately buries routine failures, while
            // approvals, media, failed tests and the first diff may surface.
            if toolMode(preferences) == "collapsed" { return false }
        }
        if message.kind == "interactive_request" {
            return !message.raw["resolved"].bool && autoExpand("approvals", preferences: preferences)
        }
        if failure(message.raw), autoExpand("errors", preferences: preferences) { return true }
        if failedTests(message.raw), autoExpand("failed_tests", preferences: preferences) { return true }
        if firstDiff, autoExpand("first_diff", preferences: preferences) { return true }
        if message.kind == "tool_call", toolMode(preferences) == "auto", message.running { return true }
        return message.kind == "plan"
    }

    static func duration(_ milliseconds: JSON) -> String? {
        guard let value = milliseconds.optionalInt else { return nil }
        return value < 1000 ? "\(value) ms" : String(format: "%.1f s", Double(value) / 1000)
    }

    static func externalURL(_ value: String) -> URL? {
        guard let url = URL(string: value), let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme), url.user == nil, url.password == nil,
              scheme == "mailto" || url.host != nil else { return nil }
        return url
    }

    static func reference(_ full: JSON, original: JSON, attachmentIndex: Int? = nil) -> JSON {
        if let attachmentIndex, full["attachments"].array.indices.contains(attachmentIndex) {
            return full["attachments"].array[attachmentIndex]
        }
        if full["image"] != .null { return full["image"] }
        return original
    }
}
