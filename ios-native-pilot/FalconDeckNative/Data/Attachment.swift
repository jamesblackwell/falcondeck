import Foundation
import ImageIO
import UIKit

struct NativeAttachment: Identifiable, Codable, Sendable, Equatable {
    let id: String
    let name: String
    let mimeType: String
    let data: Data
    var input: JSON {
        .object(["type": .string("image"), "id": .string(id), "name": .string(name), "mime_type": .string(mimeType),
                 "url": .string("data:\(mimeType);base64,\(data.base64EncodedString())"), "local_path": .null])
    }
    static func prepare(_ data: Data, name: String = "Image.jpg") throws -> NativeAttachment {
        guard !data.isEmpty, data.count <= 32_000_000,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 2048
              ] as CFDictionary) else { throw PilotError("This image couldn't be read. Choose an image smaller than 32 MB.") }
        let image = UIImage(cgImage: thumbnail)
        let alpha = thumbnail.alphaInfo
        let transparent = [.first, .last, .premultipliedFirst, .premultipliedLast].contains(alpha)
        guard let bytes = transparent ? image.pngData() : image.jpegData(compressionQuality: 0.85), bytes.count <= 10_000_000 else {
            throw PilotError("This image is too large to attach. Choose a smaller image.")
        }
        let stem = URL(fileURLWithPath: name).deletingPathExtension().lastPathComponent
        return NativeAttachment(id: UUID().uuidString, name: "\(stem.nonempty ?? "Image").\(transparent ? "png" : "jpg")", mimeType: transparent ? "image/png" : "image/jpeg", data: bytes)
    }
    static func validate(_ attachments: [NativeAttachment]) throws {
        guard attachments.allSatisfy({ !$0.data.isEmpty && $0.data.count <= 10_000_000 }), attachments.reduce(0, { $0 + $1.data.count }) <= 15_000_000 else {
            throw PilotError("Images can total at most 15 MB per message, with up to 10 MB per image.")
        }
    }
}

enum MediaURL {
    static func data(_ value: String) -> Data? {
        guard value.hasPrefix("data:image/"), let comma = value.firstIndex(of: ","), value[..<comma].hasSuffix(";base64"), value.utf8.count <= 40 * 1024 * 1024 else { return nil }
        return Data(base64Encoded: String(value[value.index(after: comma)...]))
    }
    static func external(_ value: String) -> URL? {
        guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
}
