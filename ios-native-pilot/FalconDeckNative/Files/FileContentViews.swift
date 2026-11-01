import AVKit
import ImageIO
import PDFKit
import QuickLook
import SwiftUI

/// Chooses the presentation for a loaded file. Each case reads from the local
/// cached copy, so nothing below this point touches the relay except HTML pages
/// fetching their own relative assets.
struct FileContent: View {
    @Environment(AppModel.self) private var model
    let file: LoadedFile
    let reference: FileReference
    let showSource: Bool

    var body: some View {
        switch file.meta.fileKind {
        case .markdown:
            if showSource { FileTextContent(url: file.url, language: "markdown") }
            else { FileMarkdownContent(file: file, reference: reference) }
        case .html:
            if showSource { FileTextContent(url: file.url, language: "html") }
            else { FileHTMLView(file: file, store: model.files) }
        case .pdf:
            FilePDFView(url: file.url)
        case .image:
            if file.meta.contentType == "image/svg+xml" { FileHTMLView(file: file, store: model.files) }
            else { FileImageContent(url: file.url) }
        case .video, .audio:
            FileMediaPlayer(url: file.url)
        case .code, .text:
            FileTextContent(url: file.url, language: (file.meta.name as NSString).pathExtension)
        case .binary:
            FileQuickLookView(url: file.url)
        }
    }
}

enum FileText {
    /// Rendering megabytes of text on a phone helps nobody; show the head and say so.
    static let displayLimit = 1_500_000

    static func read(_ url: URL, limit: Int = displayLimit) -> (text: String, truncated: Bool) {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return ("", false) }
        defer { try? handle.close() }
        let data = (try? handle.read(upToCount: limit + 1)) ?? Data()
        var head = data.prefix(limit)
        // Do not cut a multi-byte character in half.
        while !head.isEmpty, String(data: head, encoding: .utf8) == nil, head.count > limit - 4 { head = head.dropLast() }
        let text = String(data: head, encoding: .utf8) ?? String(decoding: head, as: UTF8.self)
        return (text, data.count > limit)
    }
}

struct FileMarkdownContent: View {
    let file: LoadedFile
    let reference: FileReference
    @State private var loaded: (text: String, truncated: Bool)?
    var body: some View {
        ScrollView {
            if let loaded {
                VStack(alignment: .leading, spacing: 16) {
                    NativeMarkdown(text: loaded.text)
                    if loaded.truncated { FileTruncationNote() }
                }
                .padding(.horizontal, 20).padding(.vertical, 16)
                .frame(maxWidth: 760).frame(maxWidth: .infinity)
            }
        }
        .environment(\.fileContext, FileContext(workspaceID: reference.workspaceID, threadID: reference.threadID, baseDir: (file.meta.path as NSString).deletingLastPathComponent))
        .task(id: file.url) { loaded = await Task.detached { FileText.read(file.url) }.value }
        .accessibilityIdentifier("file-viewer-markdown")
    }
}

private struct FileTruncationNote: View {
    var body: some View {
        Label("Showing the first part of a large file. Share it to read the rest.", systemImage: "scissors")
            .font(.footnote).foregroundStyle(FD.secondary)
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(FD.raised, in: .rect(cornerRadius: 10, style: .continuous))
    }
}

/// Monospaced, wrapping, selectable text with system find.
struct FileTextContent: View {
    let url: URL
    let language: String
    @State private var loaded: (text: String, truncated: Bool)?
    var body: some View {
        VStack(spacing: 0) {
            if let loaded {
                WrappingTextView(text: loaded.text)
                if loaded.truncated { FileTruncationNote().padding(12) }
            } else {
                ActivityDiamond().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: url) { loaded = await Task.detached { FileText.read(url) }.value }
        .accessibilityIdentifier("file-viewer-text")
    }
}

private struct WrappingTextView: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false; view.isSelectable = true; view.isFindInteractionEnabled = true
        view.backgroundColor = .clear; view.alwaysBounceVertical = true
        view.textContainerInset = UIEdgeInsets(top: 16, left: 14, bottom: 24, right: 14)
        view.adjustsFontForContentSizeCategory = true
        view.accessibilityIdentifier = "file-viewer-text-view"
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
        view.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(for: .monospacedSystemFont(ofSize: 13, weight: .regular))
        view.textColor = UIColor(FD.body)
    }
}

struct FilePDFView: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.pageShadowsEnabled = false
        view.backgroundColor = UIColor(FD.surface)
        view.accessibilityIdentifier = "file-viewer-pdf"
        view.document = PDFDocument(url: url)
        return view
    }
    func updateUIView(_ view: PDFView, context: Context) {
        if view.document?.documentURL != url { view.document = PDFDocument(url: url) }
    }
}

enum FileImage {
    /// Decodes at a bounded size so an 8000-pixel screenshot does not cost 256 MB.
    static func decode(_ url: URL, maxPixel: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixel, kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// Wide desktop screenshots: fit to the phone's width, scroll the rest, and
/// pinch or double-tap down to individual pixels.
struct FileImageContent: View {
    let url: URL
    @State private var image: UIImage?
    @State private var failed = false
    var body: some View {
        ZStack {
            if let image {
                ZoomableImage(image: image, fitWidth: true).ignoresSafeArea(edges: .bottom)
                    .accessibilityElement().accessibilityLabel("Image").accessibilityIdentifier("file-viewer-image")
            } else if failed {
                FileUnreadableNote(text: "This image couldn't be decoded.")
            } else {
                ActivityDiamond()
            }
        }
        .task(id: url) {
            let decoded = await Task.detached(priority: .userInitiated) { FileImage.decode(url, maxPixel: 6144) }.value
            image = decoded; failed = decoded == nil
        }
    }
}

struct FileUnreadableNote: View {
    let text: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle").font(.title2).foregroundStyle(FD.muted)
            Text(text).font(.subheadline).foregroundStyle(FD.secondary)
        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct FileMediaPlayer: View {
    let url: URL
    @State private var player: AVPlayer?
    var body: some View {
        Group {
            if let player { VideoPlayer(player: player) } else { ActivityDiamond() }
        }
        .task(id: url) { player = AVPlayer(url: url) }
        .onDisappear { player?.pause() }
        .accessibilityIdentifier("file-viewer-media")
    }
}

/// Office documents, archives and anything else the system can preview.
struct FileQuickLookView: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        controller.view.accessibilityIdentifier = "file-viewer-quicklook"
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        context.coordinator.url = url
        controller.reloadData()
    }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(_ url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

/// A markdown image whose destination is a file on the computer: previewed in
/// place, opened full screen on tap. Remote and data images keep the existing path.
struct LocalFileImage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.fileContext) private var context
    @Environment(\.openFile) private var openFile
    let path: String
    let alt: String
    @State private var image: UIImage?
    @State private var loading = false
    @State private var failed = false
    private var reference: FileReference { context.reference(path) }
    private var label: String { alt.nonempty ?? (path as NSString).lastPathComponent }
    var body: some View {
        Group {
            if let image {
                Button { openFile(reference) } label: {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 320).clipShape(.rect(cornerRadius: 12))
                }.buttonStyle(.plain).accessibilityLabel("Open \(label)")
            } else {
                Button { Task { await load() } } label: {
                    HStack(spacing: 8) {
                        if loading { ActivityDiamond() } else { Image(systemName: failed ? "photo.badge.exclamationmark" : "photo") }
                        Text(loading ? "Loading \(label)…" : failed ? "Couldn't load \(label) · Retry" : "Load \(label)").font(.footnote)
                    }.padding(20).frame(maxWidth: .infinity).background(FD.raised, in: .rect(cornerRadius: 12))
                }.buttonStyle(.plain).disabled(loading)
            }
        }
        .task(id: reference) { if image == nil, model.connected || model.demo { await load() } }
        .accessibilityIdentifier("local-file-image")
    }

    private func load() async {
        loading = true; failed = false
        defer { loading = false }
        do {
            let file = try await model.files.open(reference, probe: .firstRange)
            let decoded = await Task.detached(priority: .userInitiated) { FileImage.decode(file.url, maxPixel: 1400) }.value
            image = decoded; failed = decoded == nil
        } catch is CancellationError {
        } catch { failed = true }
    }
}
