import SwiftUI
import Observation

struct CachedImage: Codable, Sendable {
    let original: Data
    let thumbnail: Data
    var savedAt = Date.now
    var cost: Int { original.count + thumbnail.count }
    var valid: Bool { !original.isEmpty && original.count <= 32_000_000 && !thumbnail.isEmpty && thumbnail.count <= 10_000_000 && Date.now.timeIntervalSince(savedAt) < 7 * 86400 }
}

struct MediaImageResource: Equatable, Sendable {
    let reference: JSON
    let projectID: String
    let taskID: String
    let itemID: String
    let lifecycle: String
    init(reference: JSON, task: AgentTask?, itemID: String?, lifecycle: String = "") {
        self.reference = reference; projectID = task?.projectID ?? ""; taskID = task?.id ?? ""
        self.itemID = itemID ?? ""; self.lifecycle = lifecycle
    }
    var source: String { reference["url"].string }
    var generating: Bool { ["pending", "streaming"].contains(lifecycle) }
    var owner: AgentTask? {
        guard !projectID.isEmpty, !taskID.isEmpty, !itemID.isEmpty else { return nil }
        return AgentTask(.object(["id": .string(taskID), "workspace_id": .string(projectID)]))
    }
    /// Hydrated data URLs and their stripped history references share an owner.
    /// HTTP URLs retain their source so replacements invalidate the cache.
    var cacheIdentity: [String] {
        if owner != nil {
            return [projectID, taskID, itemID, reference["id"].string,
                reference["id"].string.isEmpty ? reference["local_path"].string : "",
                source.hasPrefix("data:image/") ? "" : source, generating ? lifecycle : "settled"]
        }
        return ["url", source]
    }
    func source(in item: JSON) -> String {
        if item["kind"].string == "image" { return item["image"]["url"].string }
        let attachments = item["attachments"].array
        let id = reference["id"].string, path = reference["local_path"].string
        if !id.isEmpty, let match = attachments.first(where: { $0["id"].string == id }) { return match["url"].string }
        if !path.isEmpty, let match = attachments.first(where: { $0["local_path"].string == path }) { return match["url"].string }
        if attachments.count == 1, let only = attachments.first, id.isEmpty || only["id"].string.isEmpty { return only["url"].string }
        return ""
    }
}

struct ImageLoadTrigger: Equatable {
    let resource: MediaImageResource
    let scope: UUID
    let connection: UUID
    let cache: ObjectIdentifier?
    let connected: Bool
    let foreground: Bool
}

/// Display state survives connection changes. Every asynchronous publication
/// belongs to one source, pairing scope and load, including cancelled views.
@MainActor @Observable final class ImageDisplay {
    private(set) var bytes: Data?
    private(set) var image: UIImage?
    private(set) var error: String?
    private(set) var loading = false
    @ObservationIgnored private var resource: MediaImageResource?
    @ObservationIgnored private var scope: UUID?
    @ObservationIgnored private var loadID = UUID()
    @ObservationIgnored private var artifact: CachedImage?
    @ObservationIgnored private var savedCache: ObjectIdentifier?

    func load(_ request: MediaImageResource, model: AppModel, foreground: Bool = true) async {
        let id = UUID(), current = model.sessionScope, cache = model.sessionCache
        loadID = id
        if resource != request || scope != current {
            image = nil; bytes = nil; error = nil; artifact = nil; savedCache = nil
            resource = request; scope = current
        }
        guard foreground else { loading = false; return }
        if image != nil {
            loading = false
            if let artifact { await persist(artifact, for: request, model: model, load: id) }
            return
        }
        loading = true; error = nil
        defer { if loadID == id { loading = false } }
        do {
            let initialSource = request.source
            let inlineData = await Task.detached { MediaURL.data(initialSource) }.value
            if !request.generating, let cached = await cache?.loadImage(request.cacheIdentity),
               inlineData == nil || inlineData == cached.original, let decoded = UIImage(data: cached.thumbnail) {
                guard loadID == id, current == model.sessionScope, !Task.isCancelled else { return }
                artifact = cached; savedCache = cache.map(ObjectIdentifier.init)
                bytes = cached.original; image = decoded; return
            }
            guard loadID == id, current == model.sessionScope, !Task.isCancelled else { return }
            if request.generating && request.source.isEmpty { return }
            var source = initialSource
            var data = inlineData
            if data == nil, MediaURL.external(source) == nil, let owner = request.owner {
                // A cached transcript can appear before the encrypted link is
                // ready. Its task is restarted when readiness/foreground changes.
                guard model.connected || model.demo else { return }
                source = request.source(in: try await model.fullItem(owner, itemID: request.itemID))
                let resolved = source
                data = await Task.detached { MediaURL.data(resolved) }.value
            }
            if data == nil, let url = MediaURL.external(source) { data = try await BoundedImageDownload.shared.download(url) }
            guard let original = data else { throw PilotError("This image is unavailable on this device.") }
            let prepared = try await Task.detached { try CachedImage(original: original, thumbnail: NativeAttachment.prepare(original).data) }.value
            guard loadID == id, current == model.sessionScope, !Task.isCancelled else { return }
            artifact = prepared
            await persist(prepared, for: request, model: model, load: id)
            guard loadID == id, current == model.sessionScope, !Task.isCancelled else { return }
            guard let decoded = UIImage(data: prepared.thumbnail) else { throw PilotError("This image couldn't be read.") }
            bytes = prepared.original; image = decoded
        } catch {
            if loadID == id, current == model.sessionScope, !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    private func persist(_ artifact: CachedImage, for request: MediaImageResource, model: AppModel, load: UUID) async {
        guard !request.generating, loadID == load, scope == model.sessionScope, !Task.isCancelled,
              let cache = model.sessionCache, savedCache != ObjectIdentifier(cache) else { return }
        do {
            try await cache.saveImage(artifact, identity: request.cacheIdentity)
            guard loadID == load, scope == model.sessionScope, !Task.isCancelled else { return }
            savedCache = ObjectIdentifier(cache)
        } catch { /* Displaying an image must not depend on a successful cache write. */ }
    }
}
