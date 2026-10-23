import SwiftUI
import UniformTypeIdentifiers
import CoreTransferable
import ImageIO

enum NativeShareFile {
    static func write(_ data: Data, title: String, fileExtension: String) throws -> URL {
        let stem = String(title.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == " " }.prefix(80)).nonempty ?? "Conversation"
        let suffix = String(fileExtension.filter { $0.isLetter || $0.isNumber }.prefix(10)).nonempty ?? "txt"
        let directory = FileManager.default.temporaryDirectory.appending(path: "NativeShares/\(UUID())", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: "\(stem).\(suffix)")
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return url
    }
}

struct ExportedImage: Transferable, Sendable {
    let data: Data
    let title: String
    private let contentType: UTType?
    init(data: Data, title: String) {
        self.data = data; self.title = title
        if let source = CGImageSourceCreateWithData(data as CFData, nil), let identifier = CGImageSourceGetType(source) { contentType = UTType(identifier as String) }
        else { contentType = nil }
    }
    func fileURL() throws -> URL {
        guard let contentType else { throw PilotError("This image couldn't be shared.") }
        let suffix = contentType.preferredFilenameExtension ?? "img"
        return try NativeShareFile.write(data, title: title, fileExtension: suffix)
    }
    static var transferRepresentation: some TransferRepresentation {
        originalFile(.png)
        originalFile(.jpeg)
        originalFile(.gif)
        originalFile(.heic)
        originalFile(.heif)
        originalFile(.webP)
        originalFile(.tiff)
        originalFile(.bmp)
        // Other ImageIO formats still export their original file without
        // claiming that the bytes are a different image format.
        FileRepresentation(exportedContentType: .data) { image in SentTransferredFile(try image.fileURL()) }
    }
    private static func originalFile(_ type: UTType) -> some TransferRepresentation<ExportedImage> {
        FileRepresentation(exportedContentType: type) { (image: ExportedImage) in SentTransferredFile(try image.fileURL()) }
            .exportingCondition { $0.contentType == type }
    }
}

struct ExportedText: Transferable, Sendable {
    let text: String
    let title: String
    var fileExtension = "md"
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .plainText) { document in
            SentTransferredFile(try NativeShareFile.write(Data(document.text.utf8), title: document.title, fileExtension: document.fileExtension))
        }
    }
}

struct TextDocumentView: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let text: String
    @State private var findRequest: UUID?
    var body: some View {
        NavigationStack {
            SelectableDocument(text: text, foreground: FD.foreground, findRequest: findRequest).background(FD.background).navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("Find in output", systemImage: "magnifyingglass") { findRequest = UUID() }.keyboardShortcut("f", modifiers: .command) }
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                    ToolbarItem(placement: .bottomBar) { ShareLink(item: ExportedText(text: text, title: title, fileExtension: "txt"), preview: SharePreview(title)) { Label("Share output", systemImage: "square.and.arrow.up") } }
                }
        }
    }
}

struct MessageTextSelection: Identifiable {
    let id = UUID()
    let text: String
}

struct MessageTextSheet: View {
    @Environment(\.dismiss) private var dismiss
    let text: String
    @State private var copied = false
    var body: some View {
        NavigationStack {
            SelectableDocument(text: text, foreground: FD.foreground, findRequest: nil, messageStyle: true)
                .background(FD.background)
                .navigationTitle("Message")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Close", systemImage: "xmark") { dismiss() }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(copied ? "Copied" : "Copy All", systemImage: copied ? "checkmark" : "doc.on.doc") {
                            UIPasteboard.general.string = text
                            copied = true
                        }
                    }
                }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

private struct SelectableDocument: UIViewControllerRepresentable {
    let text: String
    let foreground: Color
    let findRequest: UUID?
    var messageStyle = false
    @ScaledMetric(relativeTo: .body) private var messageFontSize: CGFloat = 17
    @ScaledMetric(relativeTo: .footnote) private var fontSize: CGFloat = 14
    final class Coordinator { var lastFindRequest: UUID? }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class DocumentController: UIViewController {
        let textView = UITextView()
        override func loadView() {
            textView.isEditable = false; textView.isSelectable = true
            textView.isFindInteractionEnabled = true; textView.backgroundColor = .clear
            textView.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
            textView.accessibilityIdentifier = "tool-output-text"
            view = textView
        }
    }
    func makeUIViewController(context: Context) -> DocumentController { DocumentController() }
    func updateUIViewController(_ controller: DocumentController, context: Context) {
        controller.loadViewIfNeeded()
        let view = controller.textView
        if view.text != text { view.text = text }
        view.accessibilityIdentifier = messageStyle ? "message-selection-text" : "tool-output-text"
        let font = messageStyle
            ? UIFont.systemFont(ofSize: messageFontSize)
            : UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        if view.font != font { view.font = font }
        let color = UIColor(foreground)
        if view.textColor != color { view.textColor = color }
        if let findRequest, context.coordinator.lastFindRequest != findRequest {
            context.coordinator.lastFindRequest = findRequest
            view.becomeFirstResponder()
            view.findInteraction?.presentFindNavigator(showingReplace: false)
        }
    }
}
