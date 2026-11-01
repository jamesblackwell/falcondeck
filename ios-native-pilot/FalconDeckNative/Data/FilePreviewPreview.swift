#if DEBUG
import Foundation

/// QA fixture for the file viewer: a "computer" that serves a host folder through
/// the same two RPCs as the daemon (a simplified policy: absolute or root-relative
/// paths under the fixture root, secrets denied), plus a transcript that links to
/// the files. `--file-preview=<dir>`; `--file-preview-delay=<ms>` slows each range
/// to show progress. The real policy is tested in the daemon.
actor FilePreviewRelay: RelayServing {
    let root: URL
    let delay: Duration
    init(root: URL, delay: Duration = .zero) { self.root = root.resolvingSymlinksInPath(); self.delay = delay }

    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) throws {}
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) {}
    func refresh() {}
    func detail(task: AgentTask, before: String?) throws -> JSON { .null }

    private static let types: [String: (String, String)] = [
        "md": ("text/markdown", "markdown"), "html": ("text/html", "html"), "css": ("text/css", "code"), "js": ("text/javascript", "code"),
        "json": ("application/json", "code"), "png": ("image/png", "image"), "jpg": ("image/jpeg", "image"), "pdf": ("application/pdf", "pdf"),
        "txt": ("text/plain", "text"), "csv": ("text/csv", "text"), "svg": ("image/svg+xml", "image"),
    ]

    func call(_ method: String, params: JSON) async throws -> JSON {
        guard ["file.stat", "file.read_range"].contains(method) else { throw PilotError("The preview computer is unavailable.") }
        var path = params["path"].string
        if path.hasPrefix("file://") { path = String(path.dropFirst(7)) }
        if !path.hasPrefix("/") {
            let base = params["base_dir"].string.nonempty ?? root.path
            path = URL(fileURLWithPath: base).appending(path: path).path
        }
        let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        let name = url.lastPathComponent.lowercased()
        guard url.path.hasPrefix(root.path + "/") || url.path == root.path, !name.hasPrefix(".env"), !name.hasSuffix(".pem") else {
            throw PilotError("file_denied: This file isn't shareable from your Mac.")
        }
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path), let size = attributes[.size] as? Int else {
            throw PilotError("file_not_found: This file no longer exists on your Mac.")
        }
        let modified = (attributes[.modificationDate] as? Date) ?? .now
        let type = Self.types[url.pathExtension.lowercased()] ?? ("application/octet-stream", "binary")
        var meta: [String: JSON] = [
            "path": .string(url.path), "name": .string(url.lastPathComponent), "size_bytes": .number(Double(size)),
            "modified_ms": .number((modified.timeIntervalSince1970 * 1000).rounded()), "version": .string("\(Int(modified.timeIntervalSince1970 * 1000)):\(size)"),
            "content_type": .string(type.0), "kind": .string(type.1), "max_range_bytes": .number(262_144),
        ]
        if method == "file.stat" { return .object(meta) }
        if delay > .zero { try await Task.sleep(for: delay) }
        let offset = min(params["offset"].int, size), length = min(params["length"].int, 262_144, size - offset)
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        let raw = try handle.read(upToCount: length) ?? Data()
        var payload = raw, encoding = "identity"
        if params["compress"].bool, ["markdown", "html", "code", "text"].contains(type.1), let packed = try? (raw as NSData).compressed(using: .zlib) as Data, packed.count < raw.count {
            payload = packed; encoding = "deflate"
        }
        meta["offset"] = .number(Double(offset)); meta["length"] = .number(Double(raw.count)); meta["eof"] = .bool(offset + raw.count >= size)
        meta["encoding"] = .string(encoding); meta["data_base64"] = .string(payload.base64EncodedString())
        return .object(meta)
    }
}

@MainActor enum FilePreviewPreview {
    static var rootArgument: URL? {
        ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--file-preview=") }.map { URL(fileURLWithPath: String($0.dropFirst("--file-preview=".count))) }
    }
    static var delay: Duration {
        let milliseconds = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--file-preview-delay=") }.flatMap { Int($0.dropFirst("--file-preview-delay=".count)) } ?? 0
        return .milliseconds(milliseconds)
    }

    static func start(in model: AppModel) {
        guard let root = rootArgument?.resolvingSymlinksInPath() else { return }
        let task = AgentTask(.object(["id": .string("files"), "workspace_id": .string("falcondeck"), "title": .string("Q4 review pack"), "provider": .string("claude"), "status": .string("idle"), "updated_at": .string("2026-11-01T09:00:00Z")]))
        let reply = """
        The review pack is ready.

        - Report: \(root.path)/report/index.md
        - Dashboard: [Q4 dashboard](file://\(root.path)/dashboard/index.html)
        - Brief (PDF): `\(root.path)/brief.pdf`
        - Relative to the project: report/index.md
        - Big export: \(root.path)/export.zip
        - Denied: [Credentials](\(root.path)/.env)

        ![Wide desktop screenshot](\(root.path)/wide.png)

        Open the README at https://example.com/docs/guide.html if you need context.
        """
        model.tasks = [task]; model.selection = .task(task.id); model.connected = true; model.hasLiveSnapshot = true
        let chat = model.chat(for: task)
        chat.loaded = true; chat.needsRefresh = false
        chat.transcript.items = [
            Message(.object(["id": .string("u1"), "kind": .string("user_message"), "text": .string("Put the Q4 review together and send me what to look at.")])),
            Message(.object(["id": .string("a1"), "kind": .string("assistant_message"), "text": .string(reply)])),
        ]
    }
}
#endif
