import Foundation
import OSLog

struct ChunkReceiver {
    private var id = 0
    private var index = 0
    private var total = 0
    private var bytes = Data()
    private var started = Date.distantPast
    mutating func receive(_ frame: JSON) throws -> Data? {
        let chunkID = frame["id"].int, chunkIndex = frame["index"].int, size = frame["total"].int
        guard chunkID > 0, size > 0, size <= 40 * 1024 * 1024,
              let part = Data(base64Encoded: frame["data"].string), !part.isEmpty, part.count <= 11 * 1024 else {
            throw PilotError("Invalid relay transfer.")
        }
        if bytes.isEmpty && chunkIndex == 0 {
            id = chunkID; index = 0; total = size; started = .now
        }
        guard id == chunkID, index == chunkIndex, size == total,
              bytes.count + part.count <= total, Date.now.timeIntervalSince(started) < 900,
              part.count == 11 * 1024 || bytes.count + part.count == total else { throw PilotError("Incomplete relay transfer.") }
        bytes.append(part); index += 1
        guard bytes.count == total else { return nil }
        let result = bytes
        self = .init()
        return result
    }
}

enum ClientEvent: Sendable {
    case status(String, connected: Bool)
    case snapshot(JSON)
    case error(String)
}

/// Owns networking and cryptography off the UI actor. This deliberately uses
/// authoritative snapshots instead of implementing the production event reducer.
/// It never persists replay cursors or treats relay history as a local database.
actor RelayClient {
    private let log = Logger(subsystem: "com.falcondeck.pilot.native", category: "relay")
    private let http = URLSession(configuration: .ephemeral)
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var session: SavedSession?
    private var generation = UUID()
    private var sink: AsyncStream<ClientEvent>.Continuation?
    private var pending: [String: CheckedContinuation<JSON, Error>] = [:]
    private var refreshInFlight = false
    private var lastReceived = Date.now
    private var lastBootstrapRequest = Date.distantPast

    func events() -> AsyncStream<ClientEvent> {
        let (stream, continuation) = AsyncStream<ClientEvent>.makeStream()
        sink = continuation
        return stream
    }

    func pair(_ input: PairingInput) async throws {
        let oldIdentity = try SessionVault.load()?.secret
        let identity = try RelayIdentity(secret: oldIdentity)
        let challenge = try await post(input.relay, path: "v1/pairings/challenge", body: .object(["pairing_code": .string(input.code)]))
        let nonce = challenge["challenge"].string
        guard !nonce.isEmpty else { throw PilotError("Relay did not provide a pairing challenge.") }
        let bundle = try identity.bundle()
        let authority = try RelayIdentity(secret: input.authoritySeed)
        let claim = try await post(input.relay, path: "v1/pairings/claim", body: .object([
            "pairing_code": .string(input.code), "label": .string("Falcon Native Pilot"), "client_bundle": bundle,
            "challenge_signature": .string(try identity.sign(["falcondeck-pairing-claim-v1", input.code, nonce])),
            "pairing_authority_signature": .string(try authority.sign(["falcondeck-pairing-authority-client-v1", input.code, nonce, "data_key_v1", "ed25519_v1", try identity.publicKey, try identity.identityKey]))
        ]))
        try RelayCrypto.verifyClaim(claim, input: input)
        guard !claim["session_id"].string.isEmpty, !claim["client_token"].string.isEmpty, !claim["device_id"].string.isEmpty else { throw PilotError("Relay returned an incomplete connection.") }
        let saved = SavedSession(relay: input.relay, sessionID: claim["session_id"].string, deviceID: claim["device_id"].string,
                                 token: claim["client_token"].string, secret: identity.secret,
                                 daemonKey: claim["daemon_bundle"]["public_key"].string,
                                 daemonIdentity: claim["daemon_bundle"]["identity_public_key"].string)
        try SessionVault.save(saved)
        try await connect(saved)
    }

    func restore() async throws -> Bool {
        guard let saved = try SessionVault.load() else { return false }
        try await connect(saved)
        return true
    }

    func disconnect(forget: Bool = false) throws {
        generation = UUID()
        reader?.cancel(); heartbeat?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil; session = nil; refreshInFlight = false
        failPending(PilotError("The connection closed."))
        if forget { try SessionVault.clear() }
        sink?.yield(.status("Disconnected", connected: false))
    }

    private func connect(_ saved: SavedSession) async throws {
        try disconnect()
        session = saved
        let current = generation
        sink?.yield(.status("Connecting…", connected: false))
        let relay = try PairingInput.relayURL(saved.relay.absoluteString)
        let ticket = try await post(relay, path: "v1/sessions/\(saved.sessionID)/ws-ticket", token: saved.token)
        guard current == generation else { throw CancellationError() }
        guard !ticket["ticket"].string.isEmpty else { throw PilotError("Relay did not provide a connection ticket.") }
        var c = URLComponents(url: relay.appending(path: "v1/updates/ws"), resolvingAgainstBaseURL: false)!
        c.scheme = relay.scheme == "https" ? "wss" : "ws"
        c.queryItems = [URLQueryItem(name: "session_id", value: saved.sessionID), URLQueryItem(name: "ticket", value: ticket["ticket"].string), URLQueryItem(name: "transport", value: "chunks-v1")]
        let ws = http.webSocketTask(with: c.url!)
        ws.maximumMessageSize = 40 * 1024 * 1024
        socket = ws; lastReceived = .now; ws.resume()
        reader = Task { await self.read(ws, generation: current) }
        heartbeat = Task {
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(10))
                    guard current == self.generation else { return }
                    if Date.now.timeIntervalSince(self.lastReceived) > 45 { throw PilotError("Relay stopped responding. Reconnect to try again.") }
                    try await self.send(.object(["type": .string("ping")]))
                    if self.session?.dataKey == nil { try await self.requestBootstrap() }
                    else { await self.refresh() }
                } catch is CancellationError { return }
                catch { self.connectionFailed(error, generation: current); return }
            }
        }
    }

    private func read(_ ws: URLSessionWebSocketTask, generation current: UUID) async {
        var chunks = ChunkReceiver()
        do {
            while !Task.isCancelled {
                let message = try await ws.receive()
                guard current == generation else { return }
                lastReceived = .now
                let data: Data
                switch message {
                case .data(let v): data = v
                case .string(let v): data = Data(v.utf8)
                @unknown default: continue
                }
                let frame = try JSON.decode(data)
                switch frame["type"].string {
                case "transport-ready":
                    guard frame["version"].string == "chunks-v1" else { throw PilotError("Unsupported relay transport.") }
                case "transport-chunk":
                    guard data.count <= 16 * 1024 else { throw PilotError("Relay transport frame exceeds its limit.") }
                    let complete = try chunks.receive(frame)
                    try await send(.object(["type": .string("transport-ack"), "id": frame["id"], "index": frame["index"]]))
                    guard current == generation else { return }
                    if let complete { try await handle(JSON.decode(complete)) }
                case "transport-cancel": chunks = .init()
                default: try await handle(frame)
                }
            }
        } catch is CancellationError { }
        catch { connectionFailed(error, generation: current) }
    }

    private func handle(_ frame: JSON) async throws {
        switch frame["type"].string {
        case "ready":
            log.info("Relay ready; saved content key: \(self.session?.dataKey != nil)")
            guard frame["session_id"].string == session?.sessionID, frame["role"].string == "client" else { throw PilotError("Unexpected relay session.") }
            sink?.yield(.status("Securing connection…", connected: false))
            // Fresh snapshots are our source of truth; skip old ciphertext and
            // request a signed bootstrap addressed to this independent client.
            try await send(.object(["type": .string("sync"), "after_seq": .number(Double(max(0, frame["next_seq"].int - 1)))]))
            if session?.dataKey == nil { try await requestBootstrap() }
            else { scheduleRefresh() }
        case "sync":
            for update in frame["updates"].array { try await consume(update) }
            if frame["presence"] != .null { applyPresence(frame["presence"]) }
        case "update": try await consume(frame["update"])
        case "presence": applyPresence(frame["presence"])
        case "rpc-result":
            log.info("RPC response received; success: \(frame["ok"].bool)")
            let id = frame["request_id"].string
            guard let continuation = pending.removeValue(forKey: id) else { return }
            do {
                guard let key = session?.dataKey else { throw PilotError("The encrypted session is not ready.") }
                if frame["ok"].bool {
                    continuation.resume(returning: try RelayCrypto.decrypt(frame["result"], key: key))
                } else {
                    let error = try? RelayCrypto.decrypt(frame["error"], key: key)
                    throw PilotError(error?["message"].string.nonempty ?? "The computer could not complete this request (\(frame["failure"].string)).")
                }
            } catch { continuation.resume(throwing: error) }
        case "error": throw PilotError(frame["message"].string)
        default: break
        }
    }

    private func consume(_ update: JSON) async throws {
        let body = update["body"]
        if body["t"].string == "session-bootstrap", var saved = session,
           body["material"]["client_public_key"].string == (try RelayIdentity(secret: saved.secret).publicKey) {
            saved.dataKey = try RelayCrypto.bootstrap(body["material"], session: saved)
            try SessionVault.save(saved); session = saved
            scheduleRefresh()
        } else if body["t"].string == "presence" { applyPresence(body["presence"]) }
        else if body["t"].string == "snapshot-invalidated" { scheduleRefresh() }
        // Live encrypted events are intentionally not reduced in this pilot.
        // Pull-to-refresh and a 10-second authoritative snapshot keep it current.
    }

    private func applyPresence(_ presence: JSON) {
        guard presence["daemon_connected"].bool else {
            sink?.yield(.status("Computer offline", connected: false)); return
        }
        if session?.dataKey != nil { scheduleRefresh() }
    }

    private func requestBootstrap() async throws {
        guard let saved = session, Date.now.timeIntervalSince(lastBootstrapRequest) > 3 else { return }
        lastBootstrapRequest = .now
        try await send(.object(["type": .string("ephemeral"), "body": .object([
            "kind": .string("request-bootstrap"), "device_id": .string(saved.deviceID),
            "client_bundle": try RelayIdentity(secret: saved.secret).bundle()
        ])]))
    }

    private func scheduleRefresh() { Task { await self.refresh() } }
    func refresh() async {
        guard session?.dataKey != nil, !refreshInFlight else { return }
        refreshInFlight = true
        let current = generation
        defer { if current == generation { refreshInFlight = false } }
        do {
            let result = try await call("snapshot.current", params: .object([
                "include_archived_threads": .bool(false), "include_thread_plans": .bool(false),
                "include_thread_diffs": .bool(false), "include_agent_skills": .bool(false), "include_workspace_skills": .bool(false)
            ]))
            guard current == generation else { return }
            sink?.yield(.snapshot(result)); sink?.yield(.status("Connected", connected: true))
        } catch {
            guard current == generation else { return }
            sink?.yield(.error(error.localizedDescription))
        }
    }

    func detail(task: AgentTask) async throws -> JSON {
        try await call("thread.detail", params: .object([
            "workspace_id": .string(task.projectID), "thread_id": .string(task.id),
            "mode": .string("tail"), "limit": .number(50), "strict_limit": .bool(true),
            "inline_images": .bool(false), "tool_output_bytes": .number(1024), "compact_workspace": .bool(true)
        ]))
    }

    private func call(_ method: String, params: JSON) async throws -> JSON {
        // Keep the pilot read-only at the transport boundary as well as the UI.
        guard ["snapshot.current", "thread.detail"].contains(method), let key = session?.dataKey, socket != nil else {
            throw PilotError("Connect to your computer first.")
        }
        let id = "swift-pilot-\(UUID().uuidString)"
        log.info("Requesting \(method, privacy: .public)")
        let frame = JSON.object(["type": .string("rpc-call"), "request_id": .string(id), "method": .string(method), "params": try RelayCrypto.encrypt(params, key: key)])
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task {
                do { try await self.send(frame) }
                catch { self.finish(id, error: error) }
            }
            Task {
                try? await Task.sleep(for: .seconds(30))
                self.finish(id, error: PilotError("The computer took too long to respond. Pull to refresh or reconnect."))
            }
        }
    }
    private func finish(_ id: String, error: Error) { pending.removeValue(forKey: id)?.resume(throwing: error) }
    private func failPending(_ error: Error) {
        let continuations = pending.values; pending.removeAll()
        for c in continuations { c.resume(throwing: error) }
    }
    private func connectionFailed(_ error: Error, generation current: UUID) {
        guard current == generation else { return }
        log.error("Connection failed: \(error.localizedDescription, privacy: .private)")
        socket?.cancel(with: .goingAway, reason: nil); socket = nil; heartbeat?.cancel()
        failPending(error)
        sink?.yield(.status("Disconnected", connected: false)); sink?.yield(.error(error.localizedDescription))
    }
    private func send(_ value: JSON) async throws {
        guard let socket else { throw PilotError("Relay is disconnected.") }
        let text = try value.wireText()
        // All read-only requests fit one transport frame; bulk is receive-only.
        guard text.utf8.count <= 11 * 1024 else { throw PilotError("Request exceeds the pilot’s transport limit.") }
        try await socket.send(.string(text))
    }
    private func post(_ relay: URL, path: String, body: JSON? = nil, token: String? = nil) async throws -> JSON {
        var request = URLRequest(url: relay.appending(path: path))
        request.httpMethod = "POST"; request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.httpBody = try body?.data()
        let (data, response) = try await http.data(for: request)
        let value = try? JSON.decode(data)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode), let value else {
            throw PilotError(value?["error"].string.nonempty ?? "The relay could not complete the connection. Check the address and pairing link.")
        }
        return value
    }
}

extension String {
    var nonempty: String? { isEmpty ? nil : self }
}
