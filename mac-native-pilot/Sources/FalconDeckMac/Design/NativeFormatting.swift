import Foundation

/// Timestamp helpers shared by every list that shows "when did this last move".
/// Parsing is cached because navigation and activity re-read the same handful of
/// timestamps on each snapshot, and `ISO8601DateFormatter` goes through ICU.
@MainActor enum NativeDates {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let standard = ISO8601DateFormatter()
    private static let absolute: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
    private static var parsed: [String: Date] = [:]

    static func parse(_ value: String) -> Date? {
        guard !value.isEmpty else { return nil }
        if let cached = parsed[value] { return cached }
        guard let date = fractional.date(from: value) ?? standard.date(from: value) else { return nil }
        // Bound the cache: timestamps change as tasks move, so old keys are dead weight.
        if parsed.count > 4000 { parsed.removeAll(keepingCapacity: true) }
        parsed[value] = date
        return date
    }

    /// A compact, settled label. `Text(_:style: .relative)` re-renders every
    /// second and reads as a countdown ("21 hrs, 23 min"); lists want "21h".
    static func shortRelative(_ date: Date, now: Date = Date()) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        if seconds < 7 * 86_400 { return "\(Int(seconds / 86_400))d" }
        return "\(Int(seconds / (7 * 86_400)))w"
    }

    static func shortRelative(iso value: String) -> String? {
        parse(value).map { shortRelative($0) }
    }

    static func absoluteLabel(iso value: String) -> String {
        parse(value).map { absolute.string(from: $0) } ?? ""
    }

    static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }
}

/// One readable line from a message preview: no scheduler envelope, no markdown
/// punctuation, no line breaks. Mirrors `plainPreview` in the web client so the
/// same thread reads the same way on every surface.
enum NativePlainText {
    private static let envelopeOpen = "<falcondeck_automation>"
    private static let envelopeClose = "</falcondeck_automation>"

    static func line(_ text: String, limit: Int = 240) -> String {
        guard !text.isEmpty else { return "" }
        return collapse(withoutEnvelopes(text), limit: limit)
    }

    private static func withoutEnvelopes(_ text: String) -> Substring {
        guard let open = text.range(of: envelopeOpen) else { return text[...] }
        // A scheduler envelope wraps the whole instruction; keep whatever follows it.
        guard let close = text.range(of: envelopeClose, range: open.upperBound..<text.endIndex) else {
            return text[text.startIndex..<open.lowerBound]
        }
        let head = text[text.startIndex..<open.lowerBound]
        let tail = text[close.upperBound...]
        return head.isEmpty ? tail : head
    }

    private static func collapse(_ text: Substring, limit: Int) -> String {
        var result = ""
        result.reserveCapacity(min(text.count, limit))
        var length = 0
        var index = text.startIndex
        var atLineStart = true
        var pendingSpace = false

        while index < text.endIndex, length < limit {
            let character = text[index]
            if character.isNewline {
                if length > 0 { pendingSpace = true }
                atLineStart = true
                index = text.index(after: index)
                continue
            }
            if character == " " || character == "\t" {
                if length > 0, !atLineStart { pendingSpace = true }
                index = text.index(after: index)
                continue
            }
            if atLineStart, isMarker(character) {
                // A leading run of markers plus its space is heading, quote or
                // bullet syntax, not content. A marker mid-line stays.
                var lookahead = index
                while lookahead < text.endIndex, isMarker(text[lookahead]) { lookahead = text.index(after: lookahead) }
                if lookahead < text.endIndex, text[lookahead] == " " || text[lookahead] == "\t" {
                    index = lookahead
                    continue
                }
            }
            if character == "`" {
                index = text.index(after: index)
                continue
            }
            if character == "*" || character == "_" {
                let next = text.index(after: index)
                if next < text.endIndex, text[next] == character {
                    index = text.index(after: next)
                    continue
                }
                if character == "*" {
                    index = next
                    continue
                }
            }
            if pendingSpace {
                result.append(" ")
                length += 1
                pendingSpace = false
            }
            result.append(character)
            length += 1
            atLineStart = false
            index = text.index(after: index)
        }
        return result
    }

    private static func isMarker(_ character: Character) -> Bool {
        character == "#" || character == ">" || character == "-" || character == "*" || character == "+"
    }
}
