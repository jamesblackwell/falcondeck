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
        return tools == "expanded" || tools == "auto" && message.raw["status"].string == "running"
    }
}

struct TranscriptBlock: Identifiable {
    let items: [Message]
    let grouped: Bool
    let firstDiff: Bool
    var id: String { items.first?.id ?? "" }
    var running: Bool { items.contains { $0.raw["status"].string == "running" || $0.streaming } }
    static func build(_ input: [Message], preferences: ConversationPreferences, running: Bool) -> [TranscriptBlock] {
        let source = UserTextProjection.messages(input)
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

struct TranscriptExpansion: Equatable {
    let id = UUID()
    let expanded: Bool
}
