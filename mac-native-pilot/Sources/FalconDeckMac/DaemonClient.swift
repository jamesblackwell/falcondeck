import Foundation

/// Speaks the local daemon contract. NativeRuntime owns verified discovery and
/// starts the packaged Rust runtime only when another desktop does not own it.
actor DaemonClient {
    private let configuredURL: URL?
    private let session: URLSession
    private var endpoint: URL?
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var streamID: UUID?

    init(baseURL: URL? = nil, session: URLSession = .shared) {
        configuredURL = baseURL
        self.session = session
    }

    /// Explicit override, then the installed app's ephemeral listener, then the
    /// normal development daemon. Only FalconDeck-owned listeners are probed.
    func discover() async throws -> URL {
        if let endpoint { return endpoint }
        if let configuredURL {
            let url = try Self.validateEndpoint(configuredURL)
            try await verifyHealth(url)
            endpoint = url
            return url
        }
        if let value = ProcessInfo.processInfo.environment["FALCONDECK_DAEMON_URL"], !value.isEmpty {
            guard let url = URL(string: value) else { throw PilotError("The local daemon address is invalid.") }
            let validated = try Self.validateEndpoint(url)
            try await verifyHealth(validated)
            endpoint = validated
            return validated
        }
        let resolved = try await NativeRuntime.shared.endpoint()
        endpoint = resolved
        return resolved
    }

    func snapshot() async throws -> JSON {
        try await request(["api", "snapshot"], query: [
            URLQueryItem(name: "include_archived_threads", value: "true"),
            URLQueryItem(name: "include_thread_plans", value: "false"),
            URLQueryItem(name: "include_thread_diffs", value: "false")
        ])
    }

    func connectProject(path: String) async throws -> Project {
        Project(try await request(["api", "workspaces", "connect"], method: "POST", body: .object(["path": .string(path)])))
    }

    func startThread(projectID: String, provider: String? = nil, modelID: String? = nil) async throws -> AgentTask {
        var fields: [String: JSON] = ["workspace_id": .string(projectID)]
        if let provider, !provider.isEmpty { fields["provider"] = .string(provider) }
        if let modelID, !modelID.isEmpty { fields["model_id"] = .string(modelID) }
        let result = try await request(["api", "workspaces", projectID, "threads"], method: "POST", body: .object(fields), timeout: 120)
        return AgentTask(result["thread"])
    }

    func threadDetail(projectID: String, threadID: String, before: String? = nil) async throws -> JSON {
        var query = [
            URLQueryItem(name: "mode", value: before == nil ? "tail" : "before"),
            URLQueryItem(name: "limit", value: "60"),
            URLQueryItem(name: "strict_limit", value: "true"),
            URLQueryItem(name: "inline_images", value: "false"),
            URLQueryItem(name: "tool_output_bytes", value: "8192"),
            URLQueryItem(name: "compact_workspace", value: "true")
        ]
        if let before { query.append(URLQueryItem(name: "before_item_id", value: before)) }
        return try await request(threadPath(projectID, threadID), query: query, timeout: 120)
    }

    /// Optional settings are deliberately omitted: the daemon preserves the
    /// thread's existing model, sandbox, and approval policy.
    func sendTurn(projectID: String, threadID: String, text: String, userItemID: String? = nil) async throws -> JSON {
        var fields: [String: JSON] = [
            "workspace_id": .string(projectID), "thread_id": .string(threadID),
            "inputs": .array([.object(["type": .string("text"), "text": .string(text)])])
        ]
        if let userItemID { fields["user_item_id"] = .string(userItemID) }
        return try await request(threadPath(projectID, threadID) + ["turns"], method: "POST", body: .object(fields), timeout: 120)
    }

    func interrupt(projectID: String, threadID: String) async throws {
        _ = try await request(threadPath(projectID, threadID) + ["interrupt"], method: "POST")
    }

    func markRead(projectID: String, threadID: String, readSeq: Int = 0) async throws {
        _ = try await request(threadPath(projectID, threadID) + ["read"], method: "POST", body: .object(["read_seq": .number(Double(max(0, readSeq)))]))
    }

    func respond(projectID: String, requestID: String, response: JSON) async throws {
        _ = try await request(["api", "workspaces", projectID, "interactive-requests", requestID, "respond"], method: "POST", body: .object(["response": response]))
    }

    func requestJSON(_ path: [String], method: String = "GET", query: [URLQueryItem] = [], body: JSON? = nil) async throws -> JSON {
        try await request(path, method: method, query: query, body: body, timeout: method == "GET" ? 60 : 120)
    }

    /// One connection, owned by the caller's reconnect loop. Every connection
    /// starts with a daemon snapshot, including after a restart or stream lag.
    /// The caller applies event envelopes as idempotent upserts.
    func events() async throws -> AsyncThrowingStream<JSON, Error> {
        stopStream()
        let base = try await discover()
        var components = URLComponents(url: Self.apiURL(base: base, path: ["api", "events"]), resolvingAgainstBaseURL: false)!
        components.scheme = "ws"
        var request = URLRequest(url: components.url!)
        // The daemon protects browser websocket upgrades with an exact Origin
        // allowlist. Native clients use the same local shell origin.
        request.setValue("tauri://localhost", forHTTPHeaderField: "Origin")
        let ws = session.webSocketTask(with: request)
        ws.maximumMessageSize = 64 * 1024 * 1024
        let id = UUID()
        socket = ws
        streamID = id
        ws.resume()
        return AsyncThrowingStream { continuation in
            receiveTask = Task { [weak self] in
                do {
                    while !Task.isCancelled {
                        let frame = try await ws.receive()
                        let data: Data
                        switch frame {
                        case .data(let value): data = value
                        case .string(let value): data = Data(value.utf8)
                        @unknown default: continue
                        }
                        let envelope = try JSON.decode(data)
                        guard !envelope["event"]["type"].string.isEmpty else { throw PilotError("The daemon sent an invalid event.") }
                        continuation.yield(envelope)
                    }
                    continuation.finish()
                } catch {
                    if Task.isCancelled { continuation.finish() }
                    else { continuation.finish(throwing: error) }
                }
                await self?.streamFinished(id: id)
            }
            continuation.onTermination = { [weak self] _ in
                ws.cancel(with: .goingAway, reason: nil)
                Task { await self?.stopStream(id: id) }
            }
        }
    }

    /// Clears discovery so a daemon restarted on a new ephemeral port is found.
    func disconnect() {
        stopStream()
        endpoint = nil
    }

    private func stopStream(id: UUID? = nil) {
        guard id == nil || streamID == id else { return }
        streamID = nil
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func streamFinished(id: UUID) {
        guard streamID == id else { return }
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        receiveTask = nil
        streamID = nil
        endpoint = nil
    }

    private func threadPath(_ projectID: String, _ threadID: String) -> [String] {
        ["api", "workspaces", projectID, "threads", threadID]
    }

    private func request(_ path: [String], method: String = "GET", query: [URLQueryItem] = [], body: JSON? = nil, timeout: TimeInterval = 35) async throws -> JSON {
        let base = try await discover()
        var request = URLRequest(url: Self.apiURL(base: base, path: path, query: query))
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try body.data()
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw PilotError("The local daemon did not return an HTTP response.") }
        guard (200..<300).contains(response.statusCode) else {
            let error = try? JSON.decode(data)
            let message = error?["error"].string ?? ""
            throw PilotError(message.isEmpty ? "Daemon request failed (HTTP \(response.statusCode))." : message)
        }
        if response.statusCode == 204 || data.isEmpty { return .null }
        return try JSON.decode(data)
    }

    private func verifyHealth(_ base: URL) async throws {
        var request = URLRequest(url: Self.apiURL(base: base, path: ["api", "health"]))
        request.timeoutInterval = 1.5
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { throw PilotError("The local daemon is unavailable.") }
        let health = try JSON.decode(data)
        guard health["ok"].bool, !health["version"].string.isEmpty, health["workspaces"].optionalInt != nil else {
            throw PilotError("The listener is not a FalconDeck daemon.")
        }
    }

    nonisolated static func validateEndpoint(_ url: URL) throws -> URL {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "http", let host = components.host,
              ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host.lowercased()),
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              components.port.map({ (1...65535).contains($0) }) ?? true else {
            throw PilotError("Use a local HTTP daemon address, such as http://127.0.0.1:4123.")
        }
        var normalized = components
        normalized.path = ""
        return normalized.url!
    }

    nonisolated static func apiURL(base: URL, path: [String], query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~")
        components.percentEncodedPath = "/" + path.map { $0.addingPercentEncoding(withAllowedCharacters: allowed)! }.joined(separator: "/")
        components.queryItems = query.isEmpty ? nil : query
        return components.url!
    }

    nonisolated static func listenerCandidates(from output: String) -> [URL] {
        var isDaemon = false
        var result: [URL] = []
        let commands: Set<String> = ["falcondeck-desktop", "falcondeck-daemon", "FalconDeck"]
        for line in output.split(separator: "\n") {
            switch line.first {
            case "p": isDaemon = false
            case "c": isDaemon = commands.contains(String(line.dropFirst()))
            case "n" where isDaemon:
                let listener = String(line.dropFirst())
                guard listener.hasPrefix("127.0.0.1:") || listener.hasPrefix("[::1]:"),
                      let url = URL(string: "http://" + listener),
                      let validated = try? validateEndpoint(url), !result.contains(validated) else { continue }
                result.append(validated)
            default: break
            }
        }
        return result
    }

    nonisolated private static func runningDaemonListeners() -> [URL] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return listenerCandidates(from: String(decoding: data, as: UTF8.self))
        } catch { return [] }
    }
}
