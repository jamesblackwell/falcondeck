import Foundation
import SwiftUI

/// A small block parser keeps streaming Markdown native, selectable and independent
/// of a browser. Incomplete fences remain code while an answer is arriving.
indirect enum TranscriptMarkdownBlock: Equatable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case code(language: String, text: String)
    case list(ordered: Bool, start: Int, items: [TranscriptMarkdownListItem])
    case quote([TranscriptMarkdownBlock])
    case table(headers: [String], alignments: [TranscriptTableAlignment], rows: [[String]])
    case image(alt: String, destination: String)
    case rule
}

struct TranscriptMarkdownListItem: Equatable {
    var checked: Bool?
    var blocks: [TranscriptMarkdownBlock]
}

enum TranscriptTableAlignment: Equatable {
    case leading, center, trailing

    var alignment: Alignment {
        switch self {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}

struct TranscriptMarkdownDocument {
    var blocks: [TranscriptMarkdownBlock]
    var referenceDefinitions: String
}

enum TranscriptMarkdownParser {
    private struct Fence {
        var marker: Character
        var length: Int
        var indent: Int
        var language: String
    }

    private struct ListMarker {
        var ordered: Bool
        var number: Int
        var indent: Int
        var contentIndent: Int
        var text: String
    }

    static func parse(_ source: String) -> [TranscriptMarkdownBlock] {
        document(source).blocks
    }

    static func document(_ source: String) -> TranscriptMarkdownDocument {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        var definitions: [String] = []
        let blocks = parseLines(lines, referenceDefinitions: &definitions)
        return TranscriptMarkdownDocument(blocks: blocks, referenceDefinitions: definitions.joined(separator: "\n"))
    }

    private static func parseLines(_ lines: [String], depth: Int = 0, referenceDefinitions: inout [String]) -> [TranscriptMarkdownBlock] {
        // Agent output is untrusted content. Render an excessive nesting tail as
        // literal text rather than exhausting the parser or SwiftUI view stack.
        guard depth < 32 else { return [.paragraph(lines.joined(separator: "\n"))] }
        var blocks: [TranscriptMarkdownBlock] = []
        var index = 0
        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { index += 1; continue }

            if let opening = fence(line) {
                index += 1
                var content: [String] = []
                while index < lines.count, !closesFence(lines[index], opening) {
                    content.append(removingIndent(lines[index], atMost: opening.indent))
                    index += 1
                }
                if index < lines.count { index += 1 }
                blocks.append(.code(language: opening.language, text: content.joined(separator: "\n")))
                continue
            }
            if indentation(line) >= 4 {
                var content: [String] = []
                while index < lines.count {
                    let next = lines[index]
                    if next.trimmingCharacters(in: .whitespaces).isEmpty {
                        content.append("")
                    } else if indentation(next) >= 4 {
                        content.append(removingIndent(next, atMost: 4))
                    } else { break }
                    index += 1
                }
                while content.last == "" { content.removeLast() }
                blocks.append(.code(language: "", text: content.joined(separator: "\n")))
                continue
            }
            if let definition = referenceDefinition(lines, at: index) {
                referenceDefinitions.append(definition.source)
                index = definition.next
                continue
            }
            if let heading = heading(line) {
                blocks.append(.heading(level: heading.0, text: heading.1)); index += 1; continue
            }
            if index + 1 < lines.count, let level = setextLevel(lines[index + 1]), listMarker(line) == nil {
                blocks.append(.heading(level: level, text: line.trimmingCharacters(in: .whitespaces)))
                index += 2; continue
            }
            if isRule(line) { blocks.append(.rule); index += 1; continue }
            if quoteContent(line) != nil {
                var content: [String] = []
                while index < lines.count, let quoted = quoteContent(lines[index]) {
                    content.append(quoted); index += 1
                }
                blocks.append(.quote(parseLines(content, depth: depth + 1, referenceDefinitions: &referenceDefinitions))); continue
            }
            if let marker = listMarker(line) {
                let result = parseList(lines, start: index, first: marker, depth: depth, referenceDefinitions: &referenceDefinitions)
                blocks.append(result.block); index = result.next; continue
            }
            if index + 1 < lines.count, let headers = tableCells(line), let alignments = tableSeparator(lines[index + 1]), headers.count == alignments.count {
                index += 2
                var rows: [[String]] = []
                while index < lines.count, let cells = tableCells(lines[index]), !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                    let next = lines[index]
                    if fence(next) != nil || heading(next) != nil || isRule(next) || quoteContent(next) != nil || listMarker(next) != nil { break }
                    rows.append(Array((cells + Array(repeating: "", count: headers.count)).prefix(headers.count)))
                    index += 1
                }
                blocks.append(.table(headers: headers, alignments: alignments, rows: rows)); continue
            }
            if let image = standaloneImage(line) {
                blocks.append(.image(alt: image.0, destination: image.1)); index += 1; continue
            }

            var paragraph = [paragraphLine(line)]
            index += 1
            while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                let next = lines[index]
                if let level = setextLevel(next) {
                    blocks.append(.heading(level: level, text: paragraph.joined(separator: "\n")))
                    paragraph = []; index += 1; break
                }
                if fence(next) != nil || heading(next) != nil || isRule(next) || quoteContent(next) != nil || listMarker(next) != nil || standaloneImage(next) != nil { break }
                if index + 1 < lines.count, tableCells(next) != nil, tableSeparator(lines[index + 1]) != nil { break }
                paragraph.append(paragraphLine(next)); index += 1
            }
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
        }
        return blocks
    }

    private static func paragraphLine(_ line: String) -> String {
        // Trailing spaces are Markdown hard-break syntax, including within lists.
        String(line.drop { $0 == " " || $0 == "\t" })
    }

    private static func referenceDefinition(_ lines: [String], at index: Int) -> (source: String, next: Int)? {
        guard lines[index].range(of: #"^ {0,3}\[(?:\\.|[^\[\]\\]){1,999}\]:"#, options: .regularExpression) != nil else { return nil }
        let definitionPattern = #"^ {0,3}\[(?:\\.|[^\[\]\\]){1,999}\]:[ \t]*(?:\n[ \t]*)?(?:<(?:\\.|[^<>\\\n])*>|(?:\\.|[^\s<>\\])+)(?:(?:[ \t]+|[ \t]*\n[ \t]*)(?:\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?[ \t]*$"#
        // Let Foundation validate destinations, escaping and optional titles. An
        // accepted definition produces no visible text, but so do rules and
        // other empty blocks: first require the shape of one definition only.
        for end in stride(from: min(lines.count, index + 3), through: index + 1, by: -1) {
            let candidate = lines[index..<end]
            guard candidate.allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else { continue }
            let source = candidate.joined(separator: "\n")
            guard source.range(of: definitionPattern, options: .regularExpression) != nil else { continue }
            if let parsed = try? AttributedString(markdown: source), parsed.characters.isEmpty {
                return (source, end)
            }
        }
        return nil
    }

    private static func fence(_ line: String) -> Fence? {
        let indent = indentation(line)
        guard indent <= 3 else { return nil }
        let content = removingIndent(line, atMost: indent)
        guard let marker = content.first, marker == "`" || marker == "~" else { return nil }
        let length = content.prefix { $0 == marker }.count
        guard length >= 3 else { return nil }
        let info = String(content.dropFirst(length)).trimmingCharacters(in: .whitespaces)
        guard marker != "`" || !info.contains("`") else { return nil }
        return Fence(marker: marker, length: length, indent: indent, language: info.components(separatedBy: .whitespaces).first ?? "")
    }

    private static func closesFence(_ line: String, _ opening: Fence) -> Bool {
        guard indentation(line) <= 3 else { return false }
        let content = line.trimmingCharacters(in: .whitespaces)
        let length = content.prefix { $0 == opening.marker }.count
        return length >= opening.length && content.dropFirst(length).trimmingCharacters(in: .whitespaces).isEmpty
    }

    private static func heading(_ line: String) -> (Int, String)? {
        guard indentation(line) <= 3 else { return nil }
        let content = line.trimmingCharacters(in: .whitespaces)
        let count = content.prefix { $0 == "#" }.count
        guard (1...6).contains(count), content.count == count || content.dropFirst(count).first?.isWhitespace == true else { return nil }
        var title = String(content.dropFirst(count)).trimmingCharacters(in: .whitespaces)
        if let suffixStart = title.range(of: #"\s+#+\s*$"#, options: .regularExpression) { title.removeSubrange(suffixStart) }
        return (count, title)
    }

    private static func setextLevel(_ line: String) -> Int? {
        guard indentation(line) <= 3 else { return nil }
        let text = line.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        if text.allSatisfy({ $0 == "=" }) { return 1 }
        if text.allSatisfy({ $0 == "-" }) { return 2 }
        return nil
    }

    private static func isRule(_ line: String) -> Bool {
        guard indentation(line) <= 3 else { return false }
        let compact = line.filter { !$0.isWhitespace }
        guard let marker = compact.first, ["-", "*", "_"].contains(marker), compact.count >= 3 else { return false }
        return compact.allSatisfy { $0 == marker }
    }

    private static func quoteContent(_ line: String) -> String? {
        guard indentation(line) <= 3 else { return nil }
        let text = line.drop { $0 == " " || $0 == "\t" }
        guard text.first == ">" else { return nil }
        let content = text.dropFirst()
        return String(content.first == " " ? content.dropFirst() : content)
    }

    private static func listMarker(_ line: String) -> ListMarker? {
        let indent = indentation(line)
        guard indent <= 3 else { return nil }
        let content = removingIndent(line, atMost: indent)
        let pattern = #"^([-+*]|[0-9]{1,9}[.)])([ \t]+)(.*)$"#
        guard let expression = try? NSRegularExpression(pattern: pattern), let match = expression.firstMatch(in: content, range: NSRange(content.startIndex..., in: content)), let markerRange = Range(match.range(at: 1), in: content), let gapRange = Range(match.range(at: 2), in: content), let textRange = Range(match.range(at: 3), in: content) else { return nil }
        let marker = String(content[markerRange]), gap = String(content[gapRange])
        let ordered = marker.first?.isNumber == true
        return ListMarker(ordered: ordered, number: ordered ? Int(marker.dropLast()) ?? 1 : 1, indent: indent, contentIndent: indent + marker.count + max(1, gap.count), text: String(content[textRange]))
    }

    private static func parseList(_ lines: [String], start: Int, first: ListMarker, depth: Int, referenceDefinitions: inout [String]) -> (block: TranscriptMarkdownBlock, next: Int) {
        var index = start
        var items: [TranscriptMarkdownListItem] = []
        while index < lines.count, !isRule(lines[index]), let marker = listMarker(lines[index]), marker.indent == first.indent, marker.ordered == first.ordered {
            var firstLine = marker.text
            var checked: Bool?
            if firstLine.range(of: #"^\[[ xX]\](?:\s|$)"#, options: .regularExpression) != nil {
                checked = firstLine.dropFirst().first?.lowercased() == "x"
                firstLine = paragraphLine(String(firstLine.dropFirst(3)))
            }
            var content = [firstLine]
            index += 1
            while index < lines.count {
                let next = lines[index]
                if next.trimmingCharacters(in: .whitespaces).isEmpty {
                    var following = index + 1
                    while following < lines.count, lines[following].trimmingCharacters(in: .whitespaces).isEmpty { following += 1 }
                    if following < lines.count, indentation(lines[following]) >= marker.contentIndent {
                        content.append(""); index += 1; continue
                    }
                    if following < lines.count, let sibling = listMarker(lines[following]), sibling.indent == first.indent, sibling.ordered == first.ordered { index = following }
                    break
                }
                if indentation(next) >= marker.contentIndent {
                    content.append(removingIndent(next, atMost: marker.contentIndent)); index += 1
                } else if listMarker(next) != nil || heading(next) != nil || isRule(next) || fence(next) != nil || quoteContent(next) != nil {
                    break
                } else {
                    // Markdown permits a continuation paragraph without indentation.
                    content.append(paragraphLine(next)); index += 1
                }
            }
            items.append(TranscriptMarkdownListItem(checked: checked, blocks: parseLines(content, depth: depth + 1, referenceDefinitions: &referenceDefinitions)))
        }
        return (.list(ordered: first.ordered, start: first.number, items: items), index)
    }

    /// Split only unescaped pipes outside code spans. Escapes remain available to
    /// the inline parser, so a literal pipe keeps its intended presentation.
    static func tableCells(_ line: String) -> [String]? {
        var cells: [String] = [], current = "", escaped = false, codeFence = 0, hadPipe = false
        let characters = Array(line.trimmingCharacters(in: .whitespaces))
        var index = 0
        while index < characters.count {
            let character = characters[index]
            if escaped { current.append(character); escaped = false; index += 1; continue }
            if character == "\\" { current.append(character); escaped = true; index += 1; continue }
            if character == "`" {
                var end = index + 1
                while end < characters.count, characters[end] == "`" { end += 1 }
                let length = end - index
                if codeFence == 0 { codeFence = length } else if codeFence == length { codeFence = 0 }
                current += String(repeating: "`", count: length); index = end; continue
            }
            if character == "|", codeFence == 0 {
                cells.append(current.trimmingCharacters(in: .whitespaces)); current = ""; hadPipe = true
            } else { current.append(character) }
            index += 1
        }
        guard hadPipe else { return nil }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        if characters.first == "|", cells.first == "" { cells.removeFirst() }
        if characters.last == "|", cells.last == "" { cells.removeLast() }
        return cells.isEmpty ? nil : cells
    }

    private static func tableSeparator(_ line: String) -> [TranscriptTableAlignment]? {
        guard let cells = tableCells(line), cells.allSatisfy({ $0.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil }) else { return nil }
        return cells.map { cell in
            if cell.hasPrefix(":"), cell.hasSuffix(":") { return .center }
            return cell.hasSuffix(":") ? .trailing : .leading
        }
    }

    private static func standaloneImage(_ line: String) -> (String, String)? {
        let text = line.trimmingCharacters(in: .whitespaces)
        guard let expression = try? NSRegularExpression(pattern: #"^!\[((?:\\.|[^\]\\])*)\]\((<?[^\s>]+>?)(?:\s+\"[^\"]*\")?\)$"#), let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)), let alt = Range(match.range(at: 1), in: text), let destination = Range(match.range(at: 2), in: text) else { return nil }
        return (String(text[alt]), String(text[destination]).trimmingCharacters(in: CharacterSet(charactersIn: "<>")))
    }

    private static func indentation(_ line: String) -> Int {
        var width = 0
        for character in line {
            if character == " " { width += 1 }
            else if character == "\t" { width += 4 - width % 4 }
            else { break }
        }
        return width
    }

    private static func removingIndent(_ line: String, atMost width: Int) -> String {
        var remaining = line[...], removed = 0
        while removed < width, let character = remaining.first {
            if character == " " { removed += 1; remaining = remaining.dropFirst() }
            else if character == "\t" {
                let advance = 4 - removed % 4
                remaining = remaining.dropFirst()
                removed += advance
                if removed > width { return String(repeating: " ", count: removed - width) + remaining }
            } else { break }
        }
        return String(remaining)
    }
}


/// Streaming-aware Markdown. Presentation is coalesced; the transcript keeps
/// every wire delta for copy, speech and export.
struct NativeMarkdown: View {
    @Environment(AppModel.self) private var model: AppModel?
    let text: String
    var streaming = false
    var font: Font = .body
    var foreground: Color? = nil
    @State private var display = StreamingText()
    var body: some View {
        ParsedMarkdown(text: display.displayed(text, streaming: streaming)).equatable()
            .font(font)
            .foregroundStyle(foreground ?? FD.foreground)
            .lineSpacing(4)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { url in
                if let id = TranscriptThreadLink.parse(url.absoluteString), let model {
                    Task { await model.openTask(id) }
                    return .handled
                }
                return ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
            })
            .onChange(of: text, initial: true) { _, text in display.update(text, streaming: streaming) }
            .onChange(of: streaming) { _, streaming in display.update(text, streaming: streaming) }
            .onDisappear { display.reset() }
    }
}

/// Unchanged history must not be reparsed when a neighbouring response streams.
private struct ParsedMarkdown: View, Equatable {
    let text: String
    var body: some View {
        let document = TranscriptMarkdownParser.document(text)
        TranscriptMarkdownBlocks(blocks: document.blocks, referenceDefinitions: document.referenceDefinitions)
    }
}

private struct TranscriptMarkdownBlocks: View {
    let blocks: [TranscriptMarkdownBlock]
    let referenceDefinitions: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // A live reply only changes its last block; settled ones skip their body.
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                TranscriptMarkdownBlockView(block: block, referenceDefinitions: referenceDefinitions).equatable()
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct TranscriptMarkdownBlockView: View, Equatable {
    let block: TranscriptMarkdownBlock
    let referenceDefinitions: String
    var body: some View { blockView(block) }

    @ViewBuilder private func blockView(_ block: TranscriptMarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            TranscriptInlineText(text: text, referenceDefinitions: referenceDefinitions)
        case .heading(let level, let text):
            TranscriptInlineText(text: text, referenceDefinitions: referenceDefinitions)
                .font(headingFont(level)).foregroundStyle(FD.foreground)
                .padding(.top, level < 3 ? 8 : 4)
                .accessibilityAddTraits(.isHeader)
        case .code(let language, let text):
            NativeFencedBlock(content: text, language: language)
        case .rule:
            FD.line.frame(height: 1).padding(.vertical, 6)
        case .quote(let children):
            AnyView(TranscriptMarkdownBlocks(blocks: children, referenceDefinitions: referenceDefinitions))
                .foregroundStyle(FD.secondary)
                .padding(.leading, 14)
                .overlay(alignment: .leading) { FD.line.frame(width: 3).clipShape(.capsule) }
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(items.enumerated()), id: \.offset) { offset, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let checked = item.checked {
                            Image(systemName: checked ? "checkmark.square.fill" : "square")
                                .imageScale(.small)
                                .foregroundStyle(checked ? FD.accent : FD.muted)
                                .accessibilityLabel(checked ? "Completed" : "Incomplete")
                                .frame(minWidth: 18, alignment: .leading)
                        } else {
                            Text(ordered ? "\(start + offset)." : "•")
                                .foregroundStyle(FD.muted).monospacedDigit()
                                .frame(minWidth: ordered ? 22 : 12, alignment: .leading)
                        }
                        AnyView(TranscriptMarkdownBlocks(blocks: item.blocks, referenceDefinitions: referenceDefinitions))
                    }
                }
            }
        case .table(let headers, let alignments, let rows):
            TranscriptMarkdownTable(headers: headers, alignments: alignments, rows: rows, referenceDefinitions: referenceDefinitions)
        case .image(let alt, let destination):
            MediaImageView(reference: .object(["url": .string(destination), "name": .string(alt.nonempty ?? URL(string: destination)?.lastPathComponent ?? "Image"), "alt_text": .string(alt)]))
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2.weight(.semibold)
        case 2: .title3.weight(.semibold)
        default: .headline
        }
    }
}

private struct TranscriptInlineText: View {
    let text: String
    let referenceDefinitions: String
    var body: some View {
        Text(TranscriptMarkdownInline.styled(text, referenceDefinitions: referenceDefinitions))
            .tint(FD.accent)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

enum TranscriptMarkdownInline {
    static func attributed(_ text: String, referenceDefinitions: String = "") -> AttributedString {
        // Full parsing resolves document-wide references and distinguishes hard
        // breaks from source wrapping. A removed punctuation prefix keeps #, >
        // and - inline without making leading underscore emphasis intraword.
        let prefix = ":"
        let footer = referenceDefinitions.isEmpty ? "" : "\n\n" + referenceDefinitions
        guard var value = try? AttributedString(markdown: prefix + text + footer), value.characters.first == ":" else { return AttributedString(text) }
        value.removeSubrange(value.startIndex..<value.characters.index(after: value.startIndex))
        var result = AttributedString()
        for run in value.runs {
            var segment = AttributedString(value[run.range])
            segment.presentationIntent = nil
            if let imageURL = run.imageURL {
                // Inline images stay explicit links; standalone images preview.
                if String(segment.characters) == "\u{FFFC}" { segment = AttributedString("[Linked image]") }
                segment.imageURL = nil
                segment.link = imageURL
            }
            result += segment
        }
        return result
    }

    @MainActor static func styled(_ text: String, referenceDefinitions: String = "") -> AttributedString {
        var value = attributed(text, referenceDefinitions: referenceDefinitions)
        for run in value.runs where run.inlinePresentationIntent?.contains(.code) == true {
            value[run.range].font = .system(.callout, design: .monospaced)
            value[run.range].foregroundColor = FD.accentStrong
            value[run.range].backgroundColor = FD.raised
        }
        return value
    }
}

private struct TranscriptMarkdownTable: View {
    let headers: [String]
    let alignments: [TranscriptTableAlignment]
    let rows: [[String]]
    let referenceDefinitions: String
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(headers.indices, id: \.self) { column in
                        cell(headers[column], column: column).fontWeight(.semibold).background(FD.raised)
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { row, cells in
                    GridRow {
                        ForEach(headers.indices, id: \.self) { column in
                            cell(cells[column], column: column).background(row.isMultiple(of: 2) ? Color.clear : FD.surface)
                        }
                    }
                }
            }
            .overlay { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(FD.line) }
            .clipShape(.rect(cornerRadius: 10, style: .continuous))
        }
        .font(.subheadline)
    }

    private func cell(_ text: String, column: Int) -> some View {
        Text(TranscriptMarkdownInline.styled(text, referenceDefinitions: referenceDefinitions))
            .tint(FD.accent)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .frame(minWidth: 72, maxWidth: 280, maxHeight: .infinity, alignment: alignments[column].alignment)
            .overlay(alignment: .bottom) { FD.hairline.frame(height: 1) }
            .overlay(alignment: .trailing) { FD.hairline.frame(width: 1) }
    }
}

struct NativeCodeBlock: View {
    let content: String
    var language: String? = nil
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text((language?.nonempty ?? "code").lowercased())
                    .font(.caption.monospaced()).foregroundStyle(FD.muted).lineLimit(1)
                Spacer(minLength: 8)
                Button {
                    UIPasteboard.general.string = content; copied = true
                    Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption2.weight(.medium))
                        Text(copied ? "Copied" : "Copy").font(.caption)
                    }.frame(minHeight: 32).contentShape(.rect)
                }
                .buttonStyle(.plain).foregroundStyle(copied ? FD.accent : FD.muted)
                .accessibilityLabel(copied ? "Copied" : "Copy code")
                .sensoryFeedback(.success, trigger: copied) { _, now in now }
            }
            .padding(.leading, 14).padding(.trailing, 10)
            .overlay(alignment: .bottom) { FD.hairline.frame(height: 1) }
            ScrollView(.horizontal, showsIndicators: false) {
                HighlightedCode(content: content, language: language ?? "", lightPalette: NativeAppearance.shared.lightID, darkPalette: NativeAppearance.shared.darkID).equatable()
            }
        }
        .background(FD.surface, in: .rect(cornerRadius: 12, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(FD.line) }
    }
}

private struct HighlightedCode: View, Equatable {
    let content: String
    let language: String
    let lightPalette: String
    let darkPalette: String
    var body: some View {
        Text(TranscriptSyntaxHighlight.attributed(content, language: language))
            .font(.system(.footnote, design: .monospaced)).foregroundStyle(FD.body).lineSpacing(3)
            .textSelection(.enabled).fixedSize(horizontal: true, vertical: true).padding(14)
    }
}

@MainActor enum TranscriptSyntaxHighlight {
    static func attributed(_ source: String, language: String) -> AttributedString {
        var result = AttributedString(source)
        // Avoid repeatedly tokenizing a huge tool result.
        guard source.utf16.count <= 160_000 else { return result }
        let language = language.lowercased()
        if ["diff", "patch"].contains(language) {
            var offset = source.startIndex
            for line in source.components(separatedBy: "\n") {
                let end = source.index(offset, offsetBy: line.count)
                if let range = attributedRange(offset..<end, in: result) {
                    if line.hasPrefix("+++ ") || line.hasPrefix("--- ") || line.hasPrefix("diff ") || line.hasPrefix("index ") {
                        result[range].foregroundColor = FD.muted
                    } else if line.hasPrefix("+") {
                        result[range].foregroundColor = FD.accentStrong
                        result[range].backgroundColor = FD.accentDim
                    } else if line.hasPrefix("-") {
                        result[range].foregroundColor = FD.danger
                        result[range].backgroundColor = FD.danger.opacity(0.08)
                    } else if line.hasPrefix("@@") { result[range].foregroundColor = FD.info }
                }
                offset = end < source.endIndex ? source.index(after: end) : end
            }
            return result
        }
        let known = ["swift", "rust", "rs", "javascript", "js", "jsx", "typescript", "ts", "tsx", "json", "jsonc", "python", "py", "ruby", "rb", "bash", "sh", "shell", "zsh", "go", "java", "kotlin", "c", "cpp", "c++", "css", "sql", "yaml", "yml", "toml", ""]
        guard known.contains(language) else { return result }
        let hashComment = ["python", "py", "ruby", "rb", "bash", "sh", "shell", "zsh", "yaml", "yml", "toml"].contains(language) ? "|#[^\\n]*" : ""
        let pattern = #"(?m)(//[^\n]*|/\*[\s\S]*?\*/"# + hashComment + #")|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)\b)|(\b(?:actor|as|async|await|break|case|catch|class|const|continue|def|defer|do|else|enum|export|extension|false|fn|for|from|func|function|guard|if|impl|import|in|interface|let|match|mut|nil|none|null|package|private|protected|protocol|pub|public|return|self|static|struct|super|switch|throw|throws|trait|true|try|type|typeof|use|val|var|void|where|while|with|yield)\b)"#
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return result }
        let comment = FD.muted, string = NativeAppearance.shared.color("code", "string")
        let number = NativeAppearance.shared.color("code", "number"), keyword = NativeAppearance.shared.color("code", "keyword")
        for match in expression.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            guard let stringRange = Range(match.range, in: source), let range = attributedRange(stringRange, in: result) else { continue }
            if match.range(at: 1).location != NSNotFound { result[range].foregroundColor = comment }
            else if match.range(at: 2).location != NSNotFound { result[range].foregroundColor = string }
            else if match.range(at: 3).location != NSNotFound { result[range].foregroundColor = number }
            else { result[range].foregroundColor = keyword }
        }
        return result
    }

    private static func attributedRange(_ range: Range<String.Index>, in value: AttributedString) -> Range<AttributedString.Index>? {
        guard let lower = AttributedString.Index(range.lowerBound, within: value), let upper = AttributedString.Index(range.upperBound, within: value) else { return nil }
        return lower..<upper
    }
}
