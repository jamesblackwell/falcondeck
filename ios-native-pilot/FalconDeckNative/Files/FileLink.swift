import Foundation
import SwiftUI

/// A file on the paired computer, named the way an agent wrote it. The daemon
/// resolves `~`, `file://` and relative forms, so this carries only the text and
/// the context needed to resolve it.
struct FileReference: Hashable, Identifiable, Sendable {
    var path: String
    /// Directory of the document the link was written in, for relative links.
    var baseDir: String?
    var workspaceID: String?
    var threadID: String?

    var id: String { [path, baseDir ?? "", workspaceID ?? "", threadID ?? ""].joined(separator: "\u{1F}") }
    var name: String {
        let trimmed = path.hasPrefix("file://") ? (URL(string: path)?.lastPathComponent ?? path) : path
        return (trimmed as NSString).lastPathComponent.nonempty ?? path
    }

    var params: [String: JSON] {
        var fields: [String: JSON] = ["path": .string(path)]
        if let baseDir { fields["base_dir"] = .string(baseDir) }
        if let workspaceID { fields["workspace_id"] = .string(workspaceID) }
        if let threadID { fields["thread_id"] = .string(threadID) }
        return fields
    }
}

/// Where a piece of text is being read, so a relative path in it can resolve.
struct FileContext: Hashable, Sendable {
    var workspaceID: String?
    var threadID: String?
    var baseDir: String?

    func reference(_ path: String) -> FileReference {
        FileReference(path: path, baseDir: baseDir, workspaceID: workspaceID, threadID: threadID)
    }
}

private struct FileContextKey: EnvironmentKey { static let defaultValue = FileContext() }
private struct OpenFileKey: EnvironmentKey { static let defaultValue: @MainActor @Sendable (FileReference) -> Void = { _ in } }

extension EnvironmentValues {
    var fileContext: FileContext {
        get { self[FileContextKey.self] }
        set { self[FileContextKey.self] = newValue }
    }
    /// Opens a file in the viewer owned by the nearest presenting view.
    var openFile: @MainActor @Sendable (FileReference) -> Void {
        get { self[OpenFileKey.self] }
        set { self[OpenFileKey.self] = newValue }
    }
}

/// Recognises links to files on the computer: markdown links, `file://` URLs
/// and bare paths in prose. Text is untrusted agent output, so recognition is
/// conservative: an extension we can open must end the path.
enum FileLink {
    static let scheme = "falcondeck-file"

    /// Extensions worth a tappable affordance when they appear as plain text.
    static let linkable: Set<String> = [
        "md", "markdown", "html", "htm", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "bmp", "csv", "tsv", "txt", "log",
        "json", "yaml", "yml", "toml", "xml", "css", "js", "ts", "tsx", "jsx", "swift", "rs", "py", "rb", "go", "java", "kt", "c", "h",
        "cpp", "sh", "sql", "diff", "patch", "docx", "xlsx", "pptx", "mp4", "mov", "mp3", "wav", "m4a", "zip",
    ]
    /// Bare file names in code spans link only for things people review.
    static let reviewable: Set<String> = ["md", "markdown", "html", "htm", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "csv", "txt"]

    private static let absoluteRoots = "Users|private|tmp|var|Volumes|opt|home|Library|Applications|usr|etc"
    private static let tokenCharacters = #"[^\s"'<>()\[\]{}|`]"#
    // Group 1: file URL; 2: absolute or ~ path; 3: relative path with a slash.
    private static let expression = try? NSRegularExpression(pattern:
        #"(file://\#(tokenCharacters)+)|(?<![\w/.~:@%-])((?:~|/(?:\#(absoluteRoots)))/\#(tokenCharacters)+)|(?<![\w/.~:@%#?=&+-])((?:\.{1,2}/)*[\w.+-]+(?:/[\w.+-]+)+)"#)

    /// `falcondeck-file://open?path=…`, carrying the path as written.
    static func url(for path: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme; components.host = "open"
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        return components.url
    }

    /// The file a tapped link names, or nil for links that are not files.
    static func reference(from url: URL, context: FileContext) -> FileReference? {
        switch url.scheme?.lowercased() {
        case scheme:
            guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                  let path = items.first(where: { $0.name == "path" })?.value, !path.isEmpty else { return nil }
            return context.reference(path)
        case "file":
            return context.reference(url.absoluteString)
        case nil, "":
            // A markdown link with no scheme: `[x](/Users/me/a.md)`, `(~/a.md)`, `(docs/a.md#top)`.
            guard let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path, !path.isEmpty else { return nil }
            // An absolute path in a markdown link is explicit intent: let the computer answer
            // (including "isn't shareable"). Relative links must look like files.
            if path.hasPrefix("/") || path.hasPrefix("~/") { return context.reference(path) }
            guard let ext = fileExtension(path), linkable.contains(ext) else { return nil }
            return context.reference(path)
        default:
            return nil
        }
    }

    /// `http://localhost:3000` and friends mean this Mac, not the phone.
    static func isLoopback(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let host = url.host?.lowercased() else { return false }
        return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].contains(host) || host.hasSuffix(".localhost")
    }

    static func fileExtension(_ path: String) -> String? {
        let name = (path as NSString).lastPathComponent
        let ext = (name as NSString).pathExtension.lowercased()
        return ext.isEmpty ? nil : ext
    }

    /// True when a markdown image destination points at the computer, not the web.
    static func isLocalImage(_ destination: String) -> Bool {
        let lower = destination.lowercased()
        if lower.hasPrefix("http://") || lower.hasPrefix("https://") || lower.hasPrefix("data:") || lower.hasPrefix("blob:") { return false }
        return !destination.isEmpty
    }

    /// Adds links to bare paths in `value`, leaving existing links alone.
    static func linkify(_ value: AttributedString) -> AttributedString {
        let source = String(value.characters)
        guard source.contains("/") || source.contains("."), let expression else { return value }
        var result = value
        // Code spans are written on purpose; a whole span that is a path links
        // even when it is a bare name like `report.md`.
        for run in value.runs where run.link == nil && run.inlinePresentationIntent?.contains(.code) == true {
            let text = String(value[run.range].characters)
            guard let path = codeSpanPath(text), let url = url(for: path) else { continue }
            result[run.range].link = url
        }
        guard source.contains("/") else { return result }
        for match in expression.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            guard let range = Range(match.range, in: source), let candidate = trimmed(String(source[range])),
                  let end = source.index(range.lowerBound, offsetBy: candidate.count, limitedBy: range.upperBound),
                  let lower = AttributedString.Index(range.lowerBound, within: result), let upper = AttributedString.Index(end, within: result),
                  lower < upper, !result[lower..<upper].runs.contains(where: { $0.link != nil }),
                  let url = url(for: candidate) else { continue }
            result[lower..<upper].link = url
        }
        return result
    }

    /// Strips sentence punctuation and a `:line[:col]` suffix; nil unless a
    /// linkable extension ends what remains.
    static func trimmed(_ token: String) -> String? {
        var path = token
        while let last = path.last, ".,;:!?*_".contains(last) { path.removeLast() }
        if let suffix = path.range(of: #":\d+(?::\d+)?$"#, options: .regularExpression) { path.removeSubrange(suffix) }
        guard !path.contains("://") || path.lowercased().hasPrefix("file://") else { return nil }
        guard let ext = fileExtension(path), linkable.contains(ext) else { return nil }
        return path
    }

    private static func codeSpanPath(_ text: String) -> String? {
        let text = text.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, !text.contains(where: \.isWhitespace) else { return nil }
        if text.hasPrefix("/") || text.hasPrefix("~/") || text.lowercased().hasPrefix("file://") || text.contains("/") {
            guard !text.contains("://") || text.lowercased().hasPrefix("file://") else { return nil }
            return trimmed(text)
        }
        guard let path = trimmed(text), let ext = fileExtension(path), reviewable.contains(ext) else { return nil }
        return path
    }
}
