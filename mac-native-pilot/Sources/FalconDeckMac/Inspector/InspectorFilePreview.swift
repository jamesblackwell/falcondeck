import AppKit
import AVKit
import PDFKit
import SwiftUI

@MainActor enum NativeCodeTypography {
    static var signature: String {
        let settings = NativePreferences.shared
        return "\(settings.monoFont):\(settings.monoFontCustom):\(settings.fontScale):\(settings.codeScale):\(settings.codeWeight):\(settings.theme):\(settings.lightColorTheme):\(settings.darkColorTheme)"
    }
    static func font(size: CGFloat = 12) -> NSFont {
        let settings = NativePreferences.shared
        let scaled = size * settings.fontScale * settings.codeScale
        let weight: NSFont.Weight = settings.codeWeight > 425 ? .medium : settings.codeWeight > 0 && settings.codeWeight < 326 ? .light : .regular
        let names = ["geist-mono": "Geist Mono", "jetbrains-mono": "JetBrains Mono", "fira-code": "Fira Code", "cascadia": "Cascadia Code", "menlo": "Menlo"]
        let name = settings.monoFont == "custom" ? settings.monoFontCustom : names[settings.monoFont] ?? ""
        if !name.isEmpty, let custom = NSFont(name: name, size: scaled) {
            let descriptor = custom.fontDescriptor.addingAttributes([.traits: [NSFontDescriptor.TraitKey.weight: weight.rawValue]])
            return NSFont(descriptor: descriptor, size: scaled) ?? custom
        }
        return .monospacedSystemFont(ofSize: scaled, weight: weight)
    }
}

/// A real NSTextView keeps native selection, find, accessibility and editing
/// behaviour; it renders one backing string rather than a view per source line.
struct InspectorCodeEditor: NSViewRepresentable {
    @Binding var text: String
    var editable: Bool
    var language = ""
    var diff = false
    var line: Int?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = true
        scroll.backgroundColor = NSColor(FDTheme.background)
        let view = NSTextView(frame: scroll.bounds)
        view.minSize = .zero
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = true
        view.autoresizingMask = [.width]
        view.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.textContainer?.widthTracksTextView = false
        view.textContainerInset = NSSize(width: 10, height: 10)
        let font = NativeCodeTypography.font()
        if view.font != font { view.font = font }
        view.backgroundColor = NSColor(FDTheme.background)
        view.textColor = NSColor(FDTheme.foreground)
        view.insertionPointColor = NSColor(FDTheme.accent)
        view.isRichText = false
        view.importsGraphics = false
        view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isContinuousSpellCheckingEnabled = false
        view.usesFindBar = true
        view.isIncrementalSearchingEnabled = true
        view.delegate = context.coordinator
        view.setAccessibilityLabel(editable ? "File editor" : diff ? "File diff" : "File contents")
        scroll.documentView = view
        let ruler = InspectorLineRuler(textView: view)
        scroll.verticalRulerView = ruler
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = true
        context.coordinator.textView = view
        context.coordinator.ruler = ruler
        configure(view, coordinator: context.coordinator)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView else { return }
        configure(view, coordinator: context.coordinator)
    }

    func configure(_ view: NSTextView, coordinator: Coordinator) {
        let changed = view.string != text
        let appearance = NativeCodeTypography.signature
        let styleChanged = coordinator.editable != editable || coordinator.language != language || coordinator.diff != diff || coordinator.appearance != appearance
        coordinator.editable = editable; coordinator.language = language; coordinator.diff = diff
        coordinator.appearance = appearance
        let font = NativeCodeTypography.font()
        if view.font != font { view.font = font }
        view.backgroundColor = NSColor(FDTheme.background)
        view.insertionPointColor = NSColor(FDTheme.accent)
        view.enclosingScrollView?.backgroundColor = NSColor(FDTheme.background)
        view.isEditable = editable
        view.isSelectable = true
        view.setAccessibilityLabel(editable ? "File editor" : diff ? "File diff" : "File contents")
        if changed {
            view.breakUndoCoalescing()
            coordinator.undoHistory.removeAllActions()
            let selection = view.selectedRange()
            view.string = text
            if selection.location <= (text as NSString).length { view.setSelectedRange(NSRange(location: selection.location, length: min(selection.length, (text as NSString).length - selection.location))) }
        }
        if changed || styleChanged {
            InspectorSourceStyle.apply(to: view, language: language, diff: diff, syntax: !editable)
            coordinator.ruler?.needsDisplay = true
        }
        if coordinator.requestedLine != line || changed {
            coordinator.requestedLine = line
            if let line, line > 0 {
                let content = view.string as NSString
                var position = 0, current = 1
                while position < content.length && current < line {
                    position = NSMaxRange(content.lineRange(for: NSRange(location: position, length: 0)))
                    current += 1
                }
                if position < content.length {
                    let range = content.lineRange(for: NSRange(location: position, length: 0))
                    view.setSelectedRange(range)
                    view.scrollRangeToVisible(range)
                    view.showFindIndicator(for: range)
                }
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: InspectorCodeEditor
        weak var textView: NSTextView?
        weak var ruler: InspectorLineRuler?
        var editable: Bool?
        var language = ""
        var diff = false
        var requestedLine: Int?
        var appearance = ""
        let undoHistory = UndoManager()
        init(_ parent: InspectorCodeEditor) { self.parent = parent }
        func undoManager(for view: NSTextView) -> UndoManager? { undoHistory }
        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.text = view.string
            ruler?.needsDisplay = true
        }
    }
}

final class InspectorLineRuler: NSRulerView {
    weak var source: NSTextView?
    private var observation: NSObjectProtocol?
    init(textView: NSTextView) {
        source = textView
        super.init(scrollView: textView.enclosingScrollView, orientation: .verticalRuler)
        clientView = textView
        ruleThickness = 46
        if let clip = textView.enclosingScrollView?.contentView {
            clip.postsBoundsChangedNotifications = true
            observation = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in self?.needsDisplay = true }
        }
    }
    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { if let observation { NotificationCenter.default.removeObserver(observation) } }
    override func drawHashMarksAndLabels(in rect: NSRect) {
        NSColor(FDTheme.surface).setFill(); rect.fill()
        guard let source, let layout = source.layoutManager, let container = source.textContainer, let scroll = scrollView else { return }
        let visible = source.visibleRect
        let glyphs = layout.glyphRange(forBoundingRect: visible, in: container)
        let characters = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let content = source.string as NSString
        guard content.length > 0, characters.location <= content.length else { return }
        var lineNumber = 1
        if characters.location > 0 {
            let prefix = content.substring(to: characters.location)
            lineNumber += prefix.reduce(0) { $1 == "\n" ? $0 + 1 : $0 }
        }
        var position = content.lineRange(for: NSRange(location: min(characters.location, content.length - 1), length: 0)).location
        // The first visible fragment may start in the middle of a wrapped line.
        while position < content.length && position <= NSMaxRange(characters) {
            let glyph = layout.glyphIndexForCharacter(at: position)
            let fragment = layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            let label = "\(lineNumber)" as NSString
            let attributes: [NSAttributedString.Key: Any] = [.font: NativeCodeTypography.font(size: 11), .foregroundColor: NSColor(FDTheme.subtle)]
            let size = label.size(withAttributes: attributes)
            let y = fragment.minY + source.textContainerOrigin.y - scroll.contentView.bounds.minY + 1
            label.draw(at: NSPoint(x: ruleThickness - size.width - 8, y: y), withAttributes: attributes)
            let range = content.lineRange(for: NSRange(location: position, length: 0))
            let next = NSMaxRange(range)
            guard next > position else { break }
            position = next; lineNumber += 1
        }
    }
}

@MainActor enum InspectorSourceStyle {
    static func apply(to view: NSTextView, language: String, diff: Bool, syntax: Bool) {
        guard let storage = view.textStorage else { return }
        let content = storage.string as NSString
        let full = NSRange(location: 0, length: content.length)
        storage.beginEditing()
        storage.setAttributes([.font: NativeCodeTypography.font(), .foregroundColor: NSColor(FDTheme.secondary)], range: full)
        defer { storage.endEditing() }
        guard syntax else { return }
        if diff {
            var position = 0
            while position < content.length {
                let line = content.lineRange(for: NSRange(location: position, length: 0))
                let value = content.substring(with: line)
                if value.hasPrefix("+") && !value.hasPrefix("+++") {
                    storage.addAttributes([.foregroundColor: NSColor(FDTheme.accent), .backgroundColor: NSColor(FDTheme.accentDim)], range: line)
                } else if value.hasPrefix("-") && !value.hasPrefix("---") {
                    storage.addAttributes([.foregroundColor: NSColor(FDTheme.danger), .backgroundColor: NSColor(FDTheme.danger.opacity(0.07))], range: line)
                } else if value.hasPrefix("@@") {
                    storage.addAttributes([.foregroundColor: NSColor(FDTheme.info), .backgroundColor: NSColor(FDTheme.info.opacity(0.08))], range: line)
                } else if value.hasPrefix("diff ") || value.hasPrefix("index ") || value.hasPrefix("+++") || value.hasPrefix("---") {
                    storage.addAttribute(.foregroundColor, value: NSColor(FDTheme.muted), range: line)
                }
                position = NSMaxRange(line)
            }
            return
        }
        // Bound highlighting work independently of the daemon's file cap.
        guard content.length <= 200_000 else { return }
        let keywords = "\\b(import|from|export|default|const|let|var|func|function|return|if|else|switch|case|for|while|class|struct|enum|protocol|extension|public|private|internal|protected|static|final|async|await|try|throw|throws|catch|guard|defer|in|of|new|true|false|nil|null|undefined|self|this|super|use|pub|impl|fn|mod|mut|match|Some|None|Result|Option|def|with|as|raise|except|pass|lambda|type|interface|package)\\b"
        let patterns: [(String, NSColor)] = [
            (keywords, NSColor(FDTheme.info)),
            ("\\b[0-9]+(?:\\.[0-9]+)?\\b", NSColor(FDTheme.warning)),
            (#""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'"#, NSColor(FDTheme.accentStrong)),
            (#"//[^\n]*|/\*[\s\S]*?\*/"#, NSColor(FDTheme.subtle))
        ]
        for (pattern, color) in patterns {
            guard let expression = try? NSRegularExpression(pattern: pattern) else { continue }
            expression.enumerateMatches(in: storage.string, range: full) { match, _, _ in
                if let range = match?.range { storage.addAttribute(.foregroundColor, value: color, range: range) }
            }
        }
    }
}

struct InspectorMarkdownPreview: View {
    let text: String
    private struct Block: Identifiable {
        let id: Int
        let text: String
        let kind: String
        let level: Int
    }
    private var blocks: [Block] {
        let lines = text.components(separatedBy: "\n")
        var result: [Block] = [], paragraph: [String] = [], code: [String] = []
        var fenced = false
        func append(_ value: String, _ kind: String, _ level: Int = 0) { result.append(Block(id: result.count, text: value, kind: kind, level: level)) }
        func flush() { if !paragraph.isEmpty { append(paragraph.joined(separator: "\n"), "body"); paragraph = [] } }
        for line in lines {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if fenced { append(code.joined(separator: "\n"), "code"); code = [] } else { flush() }
                fenced.toggle(); continue
            }
            if fenced { code.append(line); continue }
            let heading = line.prefix { $0 == "#" }.count
            if (1...6).contains(heading), line.dropFirst(heading).hasPrefix(" ") {
                flush(); append(String(line.dropFirst(heading + 1)), "heading", heading)
            } else if line.hasPrefix("> ") {
                flush(); append(String(line.dropFirst(2)), "quote")
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                flush(); append(String(line.dropFirst(2)), "list")
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty { flush() }
            else { paragraph.append(line) }
        }
        flush(); if !code.isEmpty { append(code.joined(separator: "\n"), "code") }
        return result
    }
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(blocks) { block in
                    if block.kind == "code" {
                        ScrollView(.horizontal) { Text(block.text).font(NativePreferences.shared.font(size: 13, surface: "code")).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(10) }
                            .background(FDTheme.raised, in: .rect(cornerRadius: 7))
                    } else if block.kind == "heading" {
                        Text(inline(block.text)).font(NativePreferences.shared.font(size: block.level == 1 ? 22 : block.level == 2 ? 18 : 15, weight: .semibold)).textSelection(.enabled).padding(.top, 4)
                    } else if block.kind == "quote" {
                        HStack(alignment: .top, spacing: 10) { Rectangle().fill(FDTheme.accent.opacity(0.4)).frame(width: 2); Text(inline(block.text)).foregroundStyle(FDTheme.muted) }.fixedSize(horizontal: false, vertical: true)
                    } else if block.kind == "list" {
                        HStack(alignment: .firstTextBaseline, spacing: 8) { Text("•").foregroundStyle(FDTheme.muted); Text(inline(block.text)).textSelection(.enabled) }
                    } else { Text(inline(block.text)).textSelection(.enabled) }
                }
            }.font(NativePreferences.shared.font(size: 13)).lineSpacing(4).frame(maxWidth: .infinity, alignment: .leading).padding(16)
        }.tint(FDTheme.accent)
    }
    private func inline(_ value: String) -> AttributedString {
        (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value)
    }
}

struct InspectorMediaPreview: View {
    let file: JSON
    @State private var image: NSImage?
    @State private var pdf: PDFDocument?
    @State private var mediaURL: URL?
    @State private var error: String?
    private var mime: String { file["mime_type"].string }
    private var identity: String { file["path"].string + ":" + file["version"].string }
    var body: some View {
        Group {
            if let image {
                ScrollView([.horizontal, .vertical]) {
                    Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: 900, maxHeight: 900).padding(20).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if let pdf { InspectorPDFView(document: pdf) }
            else if let mediaURL { InspectorPlayerView(url: mediaURL) }
            else if let error { Label(error, systemImage: "doc").font(NativePreferences.shared.font(size: 13)).foregroundStyle(FDTheme.muted).padding(20).frame(maxWidth: .infinity, maxHeight: .infinity) }
            else { MacActivityDiamond().frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
        .task(id: identity) { load() }
        .onDisappear { cleanMedia() }
    }
    private func load() {
        cleanMedia(); image = nil; pdf = nil; error = nil
        let data: Data?
        if mime == "image/svg+xml" { data = file["content"].string.data(using: .utf8) }
        else { data = Data(base64Encoded: file["content_base64"].string) }
        guard let data, !data.isEmpty else { error = "No media preview available"; return }
        if mime.hasPrefix("image/") {
            image = NSImage(data: data)
            if image == nil { error = "This image format cannot be previewed." }
        } else if mime == "application/pdf" {
            pdf = PDFDocument(data: data)
            if pdf == nil { error = "The PDF could not be opened." }
        } else if mime.hasPrefix("audio/") || mime.hasPrefix("video/") {
            let ext = URL(fileURLWithPath: file["path"].string).pathExtension
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("falcondeck-preview-\(UUID().uuidString)").appendingPathExtension(ext)
            do { try data.write(to: url, options: [.atomic]); mediaURL = url }
            catch { self.error = error.localizedDescription }
        } else { error = "No preview is available for this file format." }
    }
    private func cleanMedia() { if let mediaURL { try? FileManager.default.removeItem(at: mediaURL) }; mediaURL = nil }
}

private struct InspectorPDFView: NSViewRepresentable {
    let document: PDFDocument
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView(); view.autoScales = true; view.displayMode = .singlePageContinuous
        view.backgroundColor = NSColor(FDTheme.background); view.document = document
        return view
    }
    func updateNSView(_ view: PDFView, context: Context) { if view.document !== document { view.document = document } }
}

private struct InspectorPlayerView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView(); view.controlsStyle = .inline; view.player = AVPlayer(url: url)
        return view
    }
    func updateNSView(_ view: AVPlayerView, context: Context) {
        if (view.player?.currentItem?.asset as? AVURLAsset)?.url != url { view.player?.pause(); view.player = AVPlayer(url: url) }
    }
    static func dismantleNSView(_ view: AVPlayerView, coordinator: ()) { view.player?.pause(); view.player = nil }
}
