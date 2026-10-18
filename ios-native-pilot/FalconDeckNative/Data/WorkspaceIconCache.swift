import UIKit
import ImageIO

/// Small, disposable render artifacts shared by project headings and pins.
/// Reconnects keep decoded icons; changing the pairing clears the entire scope.
@MainActor final class WorkspaceIconCache {
    private struct Key: Hashable {
        let projectID: String
        let etag: String
        init(_ project: Project) { projectID = project.id; etag = project.raw["icon"]["etag"].string }
    }
    private struct RequestKey: Hashable { let icon: Key; let connectionID: UUID }
    private var images: [Key: UIImage] = [:]
    private var order: [Key] = []
    private var pending: [RequestKey: Task<UIImage?, Error>] = [:]
    private var generation = UUID()

    func cached(_ project: Project) -> UIImage? { images[Key(project)] }

    func load(_ project: Project, connectionID: UUID, relay: any RelayServing) async throws -> UIImage? {
        let key = Key(project)
        if let image = images[key] { return image }
        let requestKey = RequestKey(icon: key, connectionID: connectionID)
        let current = generation
        let request = pending[requestKey] ?? Task {
            let result = try await relay.call("workspace.icon", params: .object(["workspace_id": .string(project.id)]))
            try Task.checkCancellation()
            guard result["kind"].string == "image", result["data"].string.utf8.count < 1_500_000,
                  let data = Data(base64Encoded: result["data"].string) else { return nil as UIImage? }
            return await Task.detached(priority: .utility) {
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 128] as CFDictionary) else { return nil as UIImage? }
                return UIImage(cgImage: thumbnail)
            }.value
        }
        pending[requestKey] = request
        defer { if current == generation { pending[requestKey] = nil } }
        let image = try await request.value
        guard current == generation else { throw CancellationError() }
        guard let image else { return nil }
        if images[key] == nil { order.append(key) }
        images[key] = image
        while order.count > 64 { images.removeValue(forKey: order.removeFirst()) }
        return image
    }

    func reset() {
        generation = UUID()
        for request in pending.values { request.cancel() }
        pending = [:]; images = [:]; order = []
    }
}
