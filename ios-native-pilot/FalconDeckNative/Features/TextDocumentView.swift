import SwiftUI
import UniformTypeIdentifiers
import CoreTransferable

struct ExportedText: Transferable, Sendable {
    let text: String
    let title: String
    var fileExtension = "md"
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .plainText) { document in
            let stem = String(document.title.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == " " }.prefix(80)).nonempty ?? "Conversation"
            let directory = FileManager.default.temporaryDirectory.appending(path: "NativeShares/\(UUID())", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appending(path: "\(stem).\(document.fileExtension)")
            try Data(document.text.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return SentTransferredFile(url)
        }
    }
}

struct TextDocumentView: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let text: String
    var body: some View {
        NavigationStack {
            SelectableDocument(text: text).background(FD.background).navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                    ToolbarItem(placement: .bottomBar) { ShareLink(item: ExportedText(text: text, title: title, fileExtension: "txt"), preview: SharePreview(title)) { Label("Share output", systemImage: "square.and.arrow.up") } }
                }
        }
    }
}

private struct SelectableDocument: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(); view.isEditable = false; view.isSelectable = true
        view.font = .monospacedSystemFont(ofSize: 14, weight: .regular); view.backgroundColor = .clear
        view.textColor = .label; view.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) { if view.text != text { view.text = text } }
}
