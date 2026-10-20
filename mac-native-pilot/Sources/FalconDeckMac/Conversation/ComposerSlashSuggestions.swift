import SwiftUI

struct ConversationSlashItem: Identifiable {
    let raw: JSON
    let isPrompt: Bool
    var id: String { (isPrompt ? "prompt:" : "skill:") + raw["id"].string }
    var label: String { raw["label"].string.isEmpty ? raw["alias"].string : raw["label"].string }
}

enum ConversationSlash {
    struct Query {
        let start: String.Index
        let alias: String
        let arguments: String
    }
    static func query(_ text: String) -> Query? {
        let start = text.lastIndex(of: "\n").map { text.index(after: $0) } ?? text.startIndex
        let line = String(text[start...])
        guard line.hasPrefix("/") else { return nil }
        let token = String(line.prefix { !$0.isWhitespace })
        guard token.dropFirst().allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else { return nil }
        return Query(start: start, alias: token.lowercased(), arguments: String(line.dropFirst(token.count)).trimmingCharacters(in: .whitespaces))
    }
    static func suggestions(_ text: String, skills: [JSON], prompts: [JSON]) -> [ConversationSlashItem] {
        guard let query = query(text) else { return [] }
        let all = prompts.map { ConversationSlashItem(raw: $0, isPrompt: true) } + skills.map { ConversationSlashItem(raw: $0, isPrompt: false) }
        let needle = query.alias.dropFirst()
        return Array(all.filter { needle.isEmpty || ConversationCatalog.alias($0.raw["alias"].string).contains(needle) || $0.label.localizedCaseInsensitiveContains(needle) }.prefix(6))
    }
    static func insert(_ item: ConversationSlashItem, into text: String) -> String {
        guard let query = query(text) else {
            return text + (item.isPrompt ? expandPrompt(item.raw["body"].string, arguments: "") : ConversationCatalog.alias(item.raw["alias"].string) + " ")
        }
        let body = item.isPrompt ? expandPrompt(item.raw["body"].string, arguments: query.arguments) : ConversationCatalog.alias(item.raw["alias"].string) + " " + query.arguments
        return String(text[..<query.start]) + body
    }
    static func expandPrompt(_ body: String, arguments: String) -> String {
        let args = arguments.trimmingCharacters(in: .whitespacesAndNewlines)
        if body.contains("$ARGUMENTS") {
            let expanded = body.replacingOccurrences(of: "$ARGUMENTS", with: args)
            return args.isEmpty ? expanded.trimmingCharacters(in: .whitespacesAndNewlines) : expanded
        }
        guard !args.isEmpty else { return body }
        let base = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return base.isEmpty ? args : base + "\n\n" + args
    }
}

struct ConversationSlashSuggestions: View {
    let items: [ConversationSlashItem]
    let select: (ConversationSlashItem) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(items) { item in
                Button { select(item) } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: item.isPrompt ? "text.alignleft" : "bolt").frame(width: 18).padding(.top, 2).foregroundStyle(FDTheme.accent)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack { Text(item.label).font(NativePreferences.shared.font(size: 13, weight: .medium)); Spacer(); Text(item.raw["alias"].string).font(NativePreferences.shared.font(size: 11, surface: "code")).foregroundStyle(FDTheme.muted) }
                            if !item.raw["description"].string.isEmpty { Text(item.raw["description"].string).font(NativePreferences.shared.font(size: 11)).foregroundStyle(FDTheme.muted).lineLimit(1) }
                        }
                    }.padding(.horizontal, 10).padding(.vertical, 8).contentShape(.rect)
                }.buttonStyle(.plain)
            }
        }.padding(5).background(FDTheme.surface, in: .rect(cornerRadius: 9)).overlay { RoundedRectangle(cornerRadius: 9).strokeBorder(FDTheme.line) }
    }
}
