#if DEBUG
import UIKit

@MainActor enum ImagePreview {
    static let attachment = JSON.object(["id": .string("image-attachment"), "name": .string("Image.jpg"), "local_path": .string("/fixture/Image.jpg"), "mime_type": .string("image/png"), "url": .string("")])
    static var trimmedItem: JSON { fullItem.setting("attachments", .array([attachment])) }
    static var fullItem: JSON {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let bytes = UIGraphicsImageRenderer(size: CGSize(width: 240, height: 160), format: format).pngData { context in
            UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 240, height: 160))
            ("A cached image" as NSString).draw(at: CGPoint(x: 35, y: 68), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 22), .foregroundColor: UIColor.white])
        }
        return .object(["id": .string("image-item"), "kind": .string("user_message"), "text": .string("This image should survive returning to the app."),
            "attachments": .array([attachment.setting("url", .string("data:image/png;base64," + bytes.base64EncodedString()))])])
    }
    static func start(in model: AppModel) async {
        guard model.demo, let flag = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--image-preview=") }), let first = model.tasks.first else { return }
        let delayedCache = flag.hasSuffix("cache-ready")
        let restore = flag.hasSuffix("restore") || delayedCache, scope = model.sessionScope
        let root = FileManager.default.temporaryDirectory.appending(path: "NativeImagePreview")
        if !restore { try? FileManager.default.removeItem(at: root) }
        let session = SavedSession(relay: URL(string: "https://image-preview.test")!, sessionID: "image-preview", deviceID: "image-preview", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let cache = try? SessionCacheStore(session: session, root: root)
        if !delayedCache { model.sessionCache = cache }
        let task = AgentTask(first.raw.setting("status", .string("idle")))
        model.upsertTask(task.raw); model.requests = []; model.selection = .task(task.id)
        let chat = model.chat(for: task); chat.loaded = true
        chat.transcript.items = [Message(trimmedItem)]
        model.demo = false; model.hasSession = true; model.connected = false; model.hasLiveSnapshot = false; model.status = "Connecting…"
        if delayedCache {
            Task { @MainActor [weak model] in
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                guard let model, model.sessionScope == scope else { return }
                model.sessionCache = cache
            }
        } else if !restore {
            Task { @MainActor [weak model] in
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                guard let model, model.sessionScope == scope, let relay = model.relay as? ImagePreviewRelay else { return }
                await relay.ready(); model.connected = true; model.hasLiveSnapshot = true; model.status = "Connected"
            }
        }
    }
}

actor ImagePreviewRelay: RelayServing {
    private var available = false
    func ready() { available = true }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { _ in } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) async -> JSON {
        .object(["thread": task.raw, "items": .array([await ImagePreview.trimmedItem]), "has_older": .bool(false)])
    }
    func call(_ method: String, params: JSON) async throws -> JSON {
        guard available else { throw PilotError("The preview computer is disconnected.") }
        if method == "thread.item" { return await ImagePreview.fullItem }
        return .null
    }
}
#endif
