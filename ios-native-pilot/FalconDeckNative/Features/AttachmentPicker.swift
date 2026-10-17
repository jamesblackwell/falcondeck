import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct AttachmentPicker: View {
    @Bindable var chat: ChatSession
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var loading = false
    var body: some View {
        Menu {
            Button("Photo library", systemImage: "photo.on.rectangle") { showPhotos = true }
            if UIImagePickerController.isSourceTypeAvailable(.camera) { Button("Take photo", systemImage: "camera") { showCamera = true } }
            Button("Choose image file", systemImage: "folder") { showFiles = true }
            Button("Paste image", systemImage: "doc.on.clipboard") {
                guard let image = UIPasteboard.general.image, let data = image.pngData() else { chat.error = "There isn't an image on the clipboard."; return }
                add(data, name: "Clipboard.png")
            }
        } label: {
            Group { if loading { ActivityDiamond() } else { Image(systemName: "plus") } }.frame(width: 28, height: 28)
        }
        .accessibilityLabel("Add attachment").disabled(loading || chat.sending)
        .photosPicker(isPresented: $showPhotos, selection: $photos, maxSelectionCount: 10, matching: .images)
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }; loading = true
            Task {
                defer { loading = false; photos = [] }
                for item in items {
                    do {
                        guard let data = try await item.loadTransferable(type: Data.self) else { throw PilotError("Couldn't read this photo.") }
                        let attachment = try await Task.detached { try NativeAttachment.prepare(data) }.value
                        try NativeAttachment.validate(chat.attachments + [attachment]); chat.attachments.append(attachment)
                    } catch { chat.error = error.localizedDescription }
                }
            }
        }
        .sheet(isPresented: $showCamera) { NativeCamera { data in if let data { add(data, name: "Photo.jpg") }; showCamera = false } }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                loading = true
                Task {
                    defer { loading = false }
                    for url in urls {
                        do {
                            let attachment = try await Task.detached {
                                let granted = url.startAccessingSecurityScopedResource()
                                defer { if granted { url.stopAccessingSecurityScopedResource() } }
                                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                                guard size <= 32_000_000 else { throw PilotError("Choose an image smaller than 32 MB.") }
                                return try NativeAttachment.prepare(Data(contentsOf: url), name: url.lastPathComponent)
                            }.value
                            try NativeAttachment.validate(chat.attachments + [attachment]); chat.attachments.append(attachment)
                        } catch { chat.error = error.localizedDescription }
                    }
                }
            case .failure(let error): chat.error = error.localizedDescription
            }
        }
    }
    private func add(_ data: Data, name: String) {
        guard !loading else { return }; loading = true
        Task {
            defer { loading = false }
            do {
                let attachment = try await Task.detached { try NativeAttachment.prepare(data, name: name) }.value
                try NativeAttachment.validate(chat.attachments + [attachment]); chat.attachments.append(attachment)
            } catch { chat.error = error.localizedDescription }
        }
    }
}

struct AttachmentStrip: View {
    @Bindable var chat: ChatSession
    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                ForEach(chat.attachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        if let image = UIImage(data: attachment.data) { Image(uiImage: image).resizable().scaledToFill().frame(width: 72, height: 72).clipped().clipShape(.rect(cornerRadius: 10)).accessibilityLabel(attachment.name) }
                        Button { chat.attachments.removeAll { $0.id == attachment.id } } label: { Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.7)) }
                            .accessibilityLabel("Remove \(attachment.name)").disabled(chat.sending)
                    }
                }
            }
        }.scrollIndicators(.hidden)
    }
}

private struct NativeCamera: UIViewControllerRepresentable {
    let completion: (Data?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController(); picker.sourceType = .camera; picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) { }
    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let completion: (Data?) -> Void
        init(completion: @escaping (Data?) -> Void) { self.completion = completion }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) { completion((info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.85)) }
    }
}
