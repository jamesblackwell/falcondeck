import AppKit
import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// Attachments stay in the draft until the daemon confirms the send. Text files
/// are sent as explicit text context; images use the daemon's image input shape.
struct NativeMacAttachment: Codable, Equatable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable { case image, text }

    static let maximumCount = 10
    static let maximumOriginalImageBytes = 32_000_000
    static let maximumImageBytes = 10_000_000
    static let maximumTextBytes = 1_000_000
    static let maximumTotalBytes = 15_000_000

    let id: String
    let name: String
    let mimeType: String
    let data: Data
    let kind: Kind

    var text: String { kind == .text ? String(data: data, encoding: .utf8) ?? "" : "" }

    var input: JSON {
        switch kind {
        case .image:
            return .object([
                "type": .string("image"), "id": .string(id), "name": .string(name),
                "mime_type": .string(mimeType),
                "url": .string("data:\(mimeType);base64,\(data.base64EncodedString())"),
                "local_path": .null
            ])
        case .text:
            return .object([
                "type": .string("text"), "id": .string(id),
                "text": .string("Attached text file: \(name)\n\n\(text)")
            ])
        }
    }

    static func prepare(_ data: Data, name: String = "Image.png") throws -> NativeMacAttachment {
        guard !data.isEmpty else { throw PilotError("This file is empty.") }
        guard data.count <= maximumOriginalImageBytes else {
            throw PilotError("Choose an image smaller than 32 MB or a text file smaller than 1 MB.")
        }
        let filename = cleanName(name)
        if let source = CGImageSourceCreateWithData(data as CFData, nil),
           let sourceType = CGImageSourceGetType(source),
           UTType(sourceType as String)?.conforms(to: .image) == true {
            return try prepareImage(source, name: filename)
        }
        guard data.count <= maximumTextBytes else {
            throw PilotError("Text and code attachments must be smaller than 1 MB.")
        }
        guard let text = decodeText(data), isReadableText(text) else {
            throw PilotError("“\(filename)” isn't a supported image or text file. Attach images, plain text, or source code.")
        }
        let bytes = Data(text.utf8)
        guard bytes.count <= maximumTextBytes else { throw PilotError("This text file is too large to attach.") }
        let mime = UTType(filenameExtension: URL(fileURLWithPath: filename).pathExtension)?.preferredMIMEType ?? "text/plain"
        return NativeMacAttachment(id: UUID().uuidString, name: filename, mimeType: mime, data: bytes, kind: .text)
    }

    static func prepare(contentsOf url: URL) throws -> NativeMacAttachment {
        guard url.isFileURL else { throw PilotError("Choose a file from this Mac.") }
        let granted = url.startAccessingSecurityScopedResource()
        defer { if granted { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else { throw PilotError("Choose individual files rather than folders.") }
        guard let size = values.fileSize, size <= maximumOriginalImageBytes else {
            throw PilotError("“\(url.lastPathComponent)” is too large. Images can be up to 32 MB before resizing.")
        }
        return try prepare(Data(contentsOf: url), name: url.lastPathComponent)
    }

    static func validate(_ attachments: [NativeMacAttachment]) throws {
        guard attachments.count <= maximumCount else { throw PilotError("Attach up to 10 files per message.") }
        var total = 0
        for attachment in attachments {
            let maximum = attachment.kind == .image ? maximumImageBytes : maximumTextBytes
            guard !attachment.data.isEmpty, attachment.data.count <= maximum else {
                throw PilotError("Images can be up to 10 MB after resizing; text files can be up to 1 MB.")
            }
            total += attachment.data.count
            guard total <= maximumTotalBytes else { throw PilotError("Attachments can total at most 15 MB per message.") }
        }
    }

    private static func prepareImage(_ source: CGImageSource, name: String) throws -> NativeMacAttachment {
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2048,
            kCGImageSourceShouldCacheImmediately: true
        ] as CFDictionary) else { throw PilotError("This image couldn't be read. Try another image.") }
        let transparent = [CGImageAlphaInfo.first, .last, .premultipliedFirst, .premultipliedLast].contains(image.alphaInfo)
        let type: UTType = transparent ? .png : .jpeg
        let bytes = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(bytes, type.identifier as CFString, 1, nil) else {
            throw PilotError("This image couldn't be prepared.")
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination), bytes.length <= maximumImageBytes else {
            throw PilotError("This image is too large to attach. Choose a smaller image.")
        }
        let stem = URL(fileURLWithPath: name).deletingPathExtension().lastPathComponent
        return NativeMacAttachment(
            id: UUID().uuidString,
            name: "\(stem.isEmpty ? "Image" : stem).\(transparent ? "png" : "jpg")",
            mimeType: transparent ? "image/png" : "image/jpeg", data: bytes as Data, kind: .image
        )
    }

    private static func cleanName(_ name: String) -> String {
        let filename = URL(fileURLWithPath: name).lastPathComponent
            .components(separatedBy: .newlines).joined(separator: " ")
        return filename.isEmpty ? "Attachment" : filename
    }

    private static func decodeText(_ data: Data) -> String? {
        if data.starts(with: [0xff, 0xfe]) || data.starts(with: [0xfe, 0xff]) {
            return String(data: data, encoding: .utf16)
        }
        return String(data: data, encoding: .utf8)
    }

    private static func isReadableText(_ text: String) -> Bool {
        !text.unicodeScalars.contains { scalar in
            scalar.value < 32 && ![9, 10, 12, 13].contains(scalar.value)
        }
    }
}

/// File I/O and image decoding run away from the main thread for both the
/// picker and the editor's paste/drop paths.
enum ConversationAttachmentLoader {
    static func load(_ urls: [URL]) -> (attachments: [NativeMacAttachment], error: String?) {
        var attachments: [NativeMacAttachment] = []
        var errors: [String] = []
        for url in urls.prefix(NativeMacAttachment.maximumCount) {
            do {
                let attachment = try NativeMacAttachment.prepare(contentsOf: url)
                try NativeMacAttachment.validate(attachments + [attachment])
                attachments.append(attachment)
            } catch { errors.append(error.localizedDescription) }
        }
        if urls.count > NativeMacAttachment.maximumCount { errors.append("Attach up to 10 files per message.") }
        return (attachments, errors.isEmpty ? nil : errors.joined(separator: "\n"))
    }
}

@MainActor enum AttachmentPicker {
    static func pick(completion: @escaping ([NativeMacAttachment], String?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "Add attachments"
        panel.message = "Choose images, plain text, or source code. Text files are included as message context."
        panel.prompt = "Attach"
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.image, .text, .sourceCode, .json, .xml]
        panel.allowsOtherFileTypes = true
        panel.begin { response in
            guard response == .OK else { completion([], nil); return }
            let urls = panel.urls
            Task {
                let result = await Task.detached(priority: .userInitiated) { ConversationAttachmentLoader.load(urls) }.value
                completion(result.attachments, result.error)
            }
        }
    }
}

struct ConversationAttachmentStrip: View {
    let attachments: [NativeMacAttachment]
    let onRemove: (String) -> Void
    @State private var preview: NativeMacAttachment?

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 10) {
                ForEach(attachments) { attachment in
                    VStack(alignment: .leading, spacing: 5) {
                        Button { preview = attachment } label: {
                            Group {
                                if attachment.kind == .image, let image = NSImage(data: attachment.data) {
                                    Image(nsImage: image).resizable().scaledToFill()
                                } else {
                                    VStack(spacing: 6) {
                                        Image(systemName: "doc.text").font(.system(size: 22))
                                        Text("Text context").font(NativePreferences.shared.font(size: 12, surface: "chat"))
                                    }
                                    .foregroundStyle(FDTheme.muted)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                                }
                            }
                            .frame(width: 88, height: 72)
                            .background(FDTheme.surface)
                            .clipShape(.rect(cornerRadius: 8))
                            .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(FDTheme.line) }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Preview \(attachment.name)")
                        .overlay(alignment: .topTrailing) {
                            Button { onRemove(attachment.id) } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 15))
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(FDTheme.foreground, FDTheme.background)
                            }
                            .buttonStyle(.plain)
                            .padding(3)
                            .help("Remove \(attachment.name)")
                            .accessibilityLabel("Remove \(attachment.name)")
                        }
                        Text(attachment.name)
                            .font(NativePreferences.shared.font(size: 12, surface: "chat"))
                            .foregroundStyle(FDTheme.muted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(width: 88, alignment: .leading)
                            .help(attachment.name)
                    }
                }
            }
        }
        .scrollIndicators(.hidden)
        .sheet(item: $preview) { attachment in
            VStack(spacing: 0) {
                HStack {
                    Text(attachment.name).font(NativePreferences.shared.font(size: 14, surface: "chat", weight: .semibold)).lineLimit(1)
                    Spacer()
                    Button("Done") { preview = nil }
                        .font(NativePreferences.shared.font(size: 13, surface: "chat"))
                        .keyboardShortcut(.cancelAction)
                }
                .padding(16)
                Divider()
                if attachment.kind == .image, let image = NSImage(data: attachment.data) {
                    Image(nsImage: image).resizable().scaledToFit().padding(20)
                } else {
                    ScrollView([.horizontal, .vertical]) {
                        Text(attachment.text)
                            .font(NativePreferences.shared.font(size: 13, surface: "code"))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .padding(20)
                    }
                }
            }
            .frame(width: 640, height: 480)
        }
    }
}
