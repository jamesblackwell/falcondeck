import Foundation

enum ConversationExport {
    static func markdown(_ items: [Message], title: String, partial: Bool) -> String {
        var blocks = ["# " + title]
        if partial { blocks.append("> Partial export: earlier messages are not loaded.") }
        for item in items {
            switch item.kind {
            case "user_message", "assistant_message", "code_review":
                let label = item.kind == "user_message" ? "You" : item.kind == "code_review" ? "Code review" : "Assistant"
                if !item.text.isEmpty { blocks.append("## \(label)\n\n\(item.text)") }
                for attachment in item.raw["attachments"].array { blocks.append(imageDescription(attachment)) }
            case "reasoning":
                let content = item.raw["content"].string
                let summary = item.raw["summary"].string
                if !content.isEmpty || !summary.isEmpty { blocks.append("### Thinking" + (summary.isEmpty ? "" : " — " + summary) + "\n\n" + (content.isEmpty ? summary : content)) }
            case "tool_call":
                var output = "### " + (item.title.isEmpty ? "Tool activity" : item.title) + "\n\n" + code(item.text)
                if item.raw["detail"] != .null {
                    output += "\n\nTool details:\n\n" + code(TranscriptPresentation.pretty(inspectable(item.raw["detail"])), language: "json")
                }
                if item.raw["display"]["output_total_bytes"] != .null { output += "\n\n> Output preview; full output is available in the task." }
                blocks.append(output)
            case "service": if !item.text.isEmpty { blocks.append("> " + item.text) }
            case "image": blocks.append(imageDescription(item.raw["image"]))
            case "artifact":
                let artifact = item.raw["artifact"]
                blocks.append("### " + artifact["title"].string + "\n\n" + artifact["content"].string + "\n" + artifact["url"].string)
            case "diff": blocks.append("### Changes\n\n" + code(item.text, language: "diff"))
            case "file_change": for change in item.raw["changes"].array { blocks.append("### " + change["path"].string + "\n\n" + code(change["diff"].string, language: "diff")) }
            case "plan":
                let steps = item.raw["plan"]["steps"].array.map { "- [\($0["status"].string == "completed" ? "x" : " ")] \($0["step"].string)" }
                blocks.append("### Plan\n\n" + steps.joined(separator: "\n"))
            case "web_search": blocks.append("Web search: " + item.raw["search"]["query"].string + "\n" + item.raw["search"]["url"].string)
            case "context_compaction": blocks.append("> Context compacted")
            case "interactive_request": blocks.append("> " + item.raw["request"]["title"].string + " · " + (item.raw["resolved"].bool ? item.raw["resolution"]["outcome"].string : "Pending"))
            default:
                if !item.text.isEmpty { blocks.append("### " + (item.title.isEmpty ? item.kind.replacingOccurrences(of: "_", with: " ").capitalized : item.title) + "\n\n" + item.text) }
            }
        }
        return blocks.joined(separator: "\n\n---\n\n") + "\n"
    }
    static func code(_ text: String, language: String = "text") -> String {
        let longest = text.components(separatedBy: CharacterSet(charactersIn: "`" ).inverted).map(\.count).max() ?? 0
        let fence = String(repeating: "`", count: max(3, longest + 1))
        return fence + language + "\n" + text + "\n" + fence
    }
    private static func imageDescription(_ image: JSON) -> String {
        let name = image["name"].string.isEmpty ? "Image attachment" : image["name"].string
        let url = image["url"].string
        if url.hasPrefix("https://") || url.hasPrefix("http://") { return "[\(name)](\(url))" }
        return "Image: " + name
    }
    private static func inspectable(_ value: JSON) -> JSON {
        switch value {
        case .string(let text) where text.hasPrefix("data:image/") || text.hasPrefix("data:audio/"): return .string("[Binary media retained in original conversation]")
        case .array(let values): return .array(values.map(inspectable))
        case .object(let fields): return .object(fields.mapValues(inspectable))
        default: return value
        }
    }
}
