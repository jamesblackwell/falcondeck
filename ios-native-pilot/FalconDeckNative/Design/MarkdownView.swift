@preconcurrency import MarkdownUI
import SwiftUI

struct NativeMarkdown: View {
    let text: String
    var body: some View {
        Markdown(text).markdownTheme(.falcon).markdownImageProvider(ExplicitImageProvider()).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.openURL, OpenURLAction { url in
                ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
            })
    }
}

private struct ExplicitImageProvider: ImageProvider {
    func makeImage(url: URL?) -> some View {
        MediaImageView(reference: .object(["url": .string(url?.absoluteString ?? ""), "name": .string(url?.lastPathComponent ?? "Image")]))
    }
}

extension MarkdownUI.Theme {
    @MainActor static var falcon: MarkdownUI.Theme { MarkdownUI.Theme.gitHub
        .text { ForegroundColor(FD.foreground); BackgroundColor(.clear); FontSize(17) }
        .code { FontFamilyVariant(.monospaced); FontSize(.em(0.88)); BackgroundColor(FD.raised) }
        .link { ForegroundColor(FD.accent) }
        .heading1 { c in c.label.markdownTextStyle { FontSize(.em(1.4)); FontWeight(.semibold) }.markdownMargin(top: 18, bottom: 12) }
        .heading2 { c in c.label.markdownTextStyle { FontSize(.em(1.25)); FontWeight(.semibold) }.markdownMargin(top: 16, bottom: 10) }
        .heading3 { c in c.label.markdownTextStyle { FontSize(.em(1.1)); FontWeight(.semibold) }.markdownMargin(top: 14, bottom: 8) }
        .codeBlock { c in NativeFencedBlock(content: c.content, language: c.language) }
        .blockquote { c in
            HStack(spacing: 12) {
                Rectangle().fill(FD.accent).frame(width: 2)
                c.label.markdownTextStyle { ForegroundColor(FD.secondary) }
            }.fixedSize(horizontal: false, vertical: true).markdownMargin(top: 8, bottom: 12)
        }
        .table { c in
            ScrollView(.horizontal) {
                // Keep the table's intrinsic height during lazy history layout.
                c.label.markdownTableBorderStyle(.init(color: FD.line))
                    .markdownTableBackgroundStyle(.alternatingRows(FD.surface, FD.raised)).fixedSize(horizontal: true, vertical: true)
            }.markdownMargin(top: 8, bottom: 16)
        }
    }
}

struct NativeCodeBlock: View {
    let content: String
    var language: String? = nil
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language?.nonempty ?? "Code").font(.caption.monospaced()).foregroundStyle(FD.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = content; copied = true
                    Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                } label: { Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") }
                    .font(.caption).buttonStyle(.plain).foregroundStyle(FD.secondary)
            }.padding(.horizontal, 14).padding(.vertical, 10)
            Rectangle().fill(FD.line).frame(height: 1)
            ScrollView(.horizontal) {
                Text(highlighted).font(.system(.footnote, design: .monospaced)).lineSpacing(4)
                    .textSelection(.enabled).fixedSize(horizontal: true, vertical: false).padding(14)
            }
        }
        .background(FD.surface, in: .rect(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(FD.line) }.markdownMargin(top: 8, bottom: 16)
    }
    private var highlighted: AttributedString {
        var result = AttributedString(content)
        result.foregroundColor = FD.foreground
        let rules: [(String, Color)] = [
            (#"\b(func|let|var|struct|class|enum|import|return|if|else|for|while|guard|switch|case|const|function|async|await|def|fn|pub|use|true|false|null|nil|try|throw)\b"#, FD.accent),
            (#"\b\d+(?:\.\d+)?\b"#, .orange),
            (#""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'"#, .blue),
            (#"(?m)//[^\n]*|^\s*#[^\n]*"#, FD.muted)
        ]
        for (pattern, color) in rules {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            for match in regex.matches(in: content, range: NSRange(content.startIndex..., in: content)) {
                if let range = Range(match.range, in: content), let attributedRange = Range(range, in: result) { result[attributedRange].foregroundColor = color }
            }
        }
        return result
    }
}
