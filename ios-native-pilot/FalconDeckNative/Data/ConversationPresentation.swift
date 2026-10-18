import Foundation

struct ConversationPreferences {
    let raw: JSON
    var tools: String { raw["tool_details_mode"].string.nonempty ?? "collapsed" }
    var thinking: String { raw["thinking_display"].string.nonempty ?? "auto" }
    func flag(_ key: String) -> Bool { raw[key] != .bool(false) }
    func autoExpand(_ key: String) -> Bool { raw["auto_expand"][key] != .bool(false) }
    func opens(_ message: Message, firstDiff: Bool = false) -> Bool {
        if message.kind == "reasoning" { return thinking == "always_expanded" || thinking == "auto" && message.streaming }
        if autoExpand("errors"), message.raw["display"]["is_error"].bool || message.raw["status"].string == "failed" { return true }
        if autoExpand("failed_tests"), message.raw["display"]["activity_kind"].string == "test", message.raw["exit_code"] != .null, message.raw["exit_code"] != .number(0) { return true }
        if ["diff", "file_change"].contains(message.kind), firstDiff, autoExpand("first_diff") { return true }
        return tools == "expanded" || tools == "auto" && message.running
    }
}

struct TranscriptBlock: Identifiable {
    let items: [Message]
    let grouped: Bool
    let firstDiff: Bool
    var id: String { items.first?.id ?? "" }
    var running: Bool { items.contains { $0.running || $0.streaming } }
    /// Keep secondary controls on the final assistant message of each turn.
    /// Earlier commentary remains available through the message context menu.
    static func actionMessageIDs(_ input: [Message]) -> Set<String> {
        actions(in: UserTextProjection.messages(input))
    }
    fileprivate static func actions(in source: [Message]) -> Set<String> {
        var ids: Set<String> = [], pending: String?
        for message in source {
            if message.kind == "user_message" {
                if let pending { ids.insert(pending) }
                pending = nil
            } else if message.kind == "assistant_message" || message.kind == "code_review" {
                pending = message.streaming ? nil : message.id
            }
        }
        if let pending { ids.insert(pending) }
        return ids
    }
    static func build(_ input: [Message], preferences: ConversationPreferences, running: Bool) -> [TranscriptBlock] {
        blocks(from: UserTextProjection.messages(input), preferences: preferences, running: running)
    }
    fileprivate static func blocks(from source: [Message], preferences: ConversationPreferences, running: Bool) -> [TranscriptBlock] {
        var blocks: [TranscriptBlock] = [], buffer: [Message] = []
        var seenDiff = false
        func flush() { if !buffer.isEmpty { blocks.append(TranscriptBlock(items: buffer, grouped: true, firstDiff: false)); buffer = [] } }
        for (index, original) in source.enumerated() {
            var item = original
            if item.kind == "reasoning", item.streaming, !running || index < source.count - 1 { item.raw = item.raw.setting("lifecycle", .string("complete")) }
            let isDiff = ["diff", "file_change"].contains(item.kind)
            let first = isDiff && !seenDiff
            if isDiff { seenDiff = true }
            let tool = item.kind == "tool_call"
            let readOnly = item.raw["display"]["is_read_only"].bool || item.raw["display"]["history_mode"].string == "summary"
            let group = !preferences.opens(item, firstDiff: first) && (tool && (preferences.tools == "collapsed" || preferences.flag("group_read_only_tools") && readOnly) || item.kind == "reasoning" && preferences.tools == "collapsed" && !buffer.isEmpty)
            if group { buffer.append(item) }
            else { flush(); blocks.append(TranscriptBlock(items: [item], grouped: false, firstDiff: first)) }
        }
        flush(); return blocks
    }
}

/// One projection shared by row grouping and turn actions. ChatSession retains
/// only the latest result, so draft edits and scroll geometry don't rebuild it.
struct TranscriptPresentation {
    let blocks: [TranscriptBlock]
    let actionIDs: Set<String>
    init(_ items: [Message], preferences: ConversationPreferences, running: Bool) {
        let source = UserTextProjection.messages(items)
        blocks = TranscriptBlock.blocks(from: source, preferences: preferences, running: running)
        actionIDs = TranscriptBlock.actions(in: source)
    }
}

struct TranscriptExpansion: Equatable {
    let id = UUID()
    let expanded: Bool
}

enum ConversationActivity {
    static func reasoningLabel(_ item: Message) -> String {
        if item.streaming { return "Thinking…" }
        if item.raw["lifecycle"].string == "interrupted" { return "Thought interrupted" }
        if item.raw["lifecycle"].string == "error" { return "Thought failed" }
        return item.raw["summary"].string.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? "Thought process"
    }
    /// Match Expo's fallback: live reasoning and tool activity own their status.
    static func label(blocks: [TranscriptBlock], running: Bool, submitting: Bool) -> String? {
        guard running else { return submitting ? "Sending…" : nil }
        guard let last = blocks.last else { return "Thinking…" }
        if last.grouped && last.running { return nil }
        if let item = last.items.last {
            if item.kind == "reasoning", item.streaming { return nil }
            if item.kind == "tool_call", item.running { return nil }
        }
        return "Thinking…"
    }
}
