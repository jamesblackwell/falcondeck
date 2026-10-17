import Foundation

enum TranscriptExport {
    static func markdown(_ items: [Message], title: String, partial: Bool) -> String {
        var blocks = ["# \(title)"]
        if partial { blocks.append("> Partial export: earlier messages are not loaded.") }
        for item in items {
            switch item.kind {
            case "user_message", "assistant_message", "code_review":
                let label = item.kind == "user_message" ? "You" : item.kind == "code_review" ? "Code review" : "Assistant"
                if !item.text.isEmpty { blocks.append("## \(label)\n\n\(item.text)") }
                for image in item.raw["attachments"].array { blocks.append("Image: \(image["name"].string.nonempty ?? "Attachment")") }
            case "reasoning": if !item.text.isEmpty { blocks.append("### Thinking\n\n\(item.text)") }
            case "tool_call":
                var output = "### \(item.raw["title"].string.nonempty ?? "Tool activity")\n\n\(code(item.text))"
                if item.raw["display"]["output_total_bytes"] != .null { output += "\n\n> Output preview; the full output is available in the task." }
                blocks.append(output)
            case "service": blocks.append("> \(item.text)")
            case "image": blocks.append("Image: \(item.raw["title"].string.nonempty ?? item.raw["image"]["name"].string.nonempty ?? "Agent image")")
            case "artifact": blocks.append("### \(item.raw["artifact"]["title"].string)\n\n\(item.raw["artifact"]["content"].string)")
            case "diff": blocks.append("### Changes\n\n\(code(item.text))")
            case "file_change":
                for change in item.raw["changes"].array { blocks.append("### \(change["path"].string)\n\n\(code(change["diff"].string))") }
            case "plan":
                let steps = item.raw["plan"]["steps"].array.map { "- [\($0["status"].string == "completed" ? "x" : " ")] \($0["step"].string)" }
                blocks.append("### Plan\n\n\(steps.joined(separator: "\n"))")
            case "web_search": blocks.append("Web search: \(item.raw["search"]["query"].string)\n\(item.raw["search"]["url"].string)")
            case "context_compaction": blocks.append("> Context compacted")
            case "interactive_request":
                blocks.append("> \(item.raw["request"]["title"].string) · \(item.raw["resolved"].bool ? item.raw["resolution"]["outcome"].string : "Pending")")
            default: blocks.append("> \(item.raw["title"].string.nonempty ?? item.kind)")
            }
        }
        return blocks.joined(separator: "\n\n---\n\n") + "\n"
    }
    private static func code(_ text: String) -> String {
        let longest = text.split(whereSeparator: { $0 != "`" }).map(\.count).max() ?? 0
        let fence = String(repeating: "`", count: max(3, longest + 1))
        return "\(fence)text\n\(text)\n\(fence)"
    }
}
