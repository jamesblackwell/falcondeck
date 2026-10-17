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
    case events([JSON])
    case rebase([JSON])
    case error(String)
}

struct RelayUpdate: Sendable {
    let connectionID: UUID
    let event: ClientEvent
}

protocol RelayServing: Sendable {
    func events() async -> AsyncStream<RelayUpdate>
    func pair(_ input: PairingInput, connectionID: UUID) async throws
    func restore(connectionID: UUID) async throws -> Bool
    func disconnect(forget: Bool) async throws
    func refresh() async
    func detail(task: AgentTask, before: String?) async throws -> JSON
    func call(_ method: String, params: JSON) async throws -> JSON
}

/// Owns networking and cryptography off the UI actor. A fresh daemon snapshot
/// anchors every connection; ordered live events follow it. No history DB or
/// durable replay cursor is added by this client.
actor RelayClient: RelayServing {
    private let log = Logger(subsystem: "com.falcondeck.pilot.native", category: "relay")
    private let http = URLSession(configuration: .ephemeral)
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var session: SavedSession?
    private var generation = UUID()
    private var sink: AsyncStream<RelayUpdate>.Continuation?
    private var pending: [String: CheckedContinuation<JSON, Error>] = [:]
    private var refreshInFlight = false
    private var lastReceived = Date.now
    private var lastBootstrapRequest = Date.distantPast
    private var bufferedEvents: [JSON] = []
    private var transferID = 0
    private var bulkSending = false
    private var acknowledgements: [String: CheckedContinuation<Void, Error>] = [:]

    func events() -> AsyncStream<RelayUpdate> {
        let (stream, continuation) = AsyncStream<RelayUpdate>.makeStream()
        sink = continuation
        return stream
    }

    private func emit(_ event: ClientEvent) {
        sink?.yield(RelayUpdate(connectionID: generation, event: event))
    }

    private func beginConnection(_ connectionID: UUID) throws {
        try disconnect()
        generation = connectionID
        lastBootstrapRequest = .distantPast
    }

    func pair(_ input: PairingInput, connectionID: UUID) async throws {
        try beginConnection(connectionID)
        let oldIdentity = try SessionVault.load()?.secret
        let identity = try RelayIdentity(secret: oldIdentity)
        let challenge = try await post(input.relay, path: "v1/pairings/challenge", body: .object(["pairing_code": .string(input.code)]))
        guard generation == connectionID else { throw CancellationError() }
        let nonce = challenge["challenge"].string
        guard !nonce.isEmpty else { throw PilotError("Relay did not provide a pairing challenge.") }
        let bundle = try identity.bundle()
        let authority = try RelayIdentity(secret: input.authoritySeed)
        let claim = try await post(input.relay, path: "v1/pairings/claim", body: .object([
            "pairing_code": .string(input.code), "label": .string("Falcon Native Pilot"), "client_bundle": bundle,
            "challenge_signature": .string(try identity.sign(["falcondeck-pairing-claim-v1", input.code, nonce])),
            "pairing_authority_signature": .string(try authority.sign(["falcondeck-pairing-authority-client-v1", input.code, nonce, "data_key_v1", "ed25519_v1", try identity.publicKey, try identity.identityKey]))
        ]))
        guard generation == connectionID else { throw CancellationError() }
        try RelayCrypto.verifyClaim(claim, input: input)
        guard !claim["session_id"].string.isEmpty, !claim["client_token"].string.isEmpty, !claim["device_id"].string.isEmpty else { throw PilotError("Relay returned an incomplete connection.") }
        let saved = SavedSession(relay: input.relay, sessionID: claim["session_id"].string, deviceID: claim["device_id"].string,
                                 token: claim["client_token"].string, secret: identity.secret,
                                 daemonKey: claim["daemon_bundle"]["public_key"].string,
                                 daemonIdentity: claim["daemon_bundle"]["identity_public_key"].string)
        try SessionVault.save(saved)
        try await connect(saved)
    }

    func restore(connectionID: UUID) async throws -> Bool {
        try beginConnection(connectionID)
        guard let saved = try SessionVault.load() else { return false }
        try await connect(saved)
        return true
    }

    func disconnect(forget: Bool = false) throws {
        generation = UUID()
        reader?.cancel(); heartbeat?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil; session = nil; refreshInFlight = false; bulkSending = false
        bufferedEvents = []
        failPending(PilotError("The connection closed."))
        if forget { try SessionVault.clear() }
        emit(.status("Disconnected", connected: false))
    }

    private func connect(_ saved: SavedSession) async throws {
        session = saved
        let current = generation
        emit(.status("Connecting…", connected: false))
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
                    guard current == self.generation else { return }
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
                    if let complete { try await handle(JSON.decode(complete), generation: current) }
                case "transport-cancel": chunks = .init()
                case "transport-ack":
                    let key = "\(frame["id"].int):\(frame["index"].int)"
                    acknowledgements.removeValue(forKey: key)?.resume()
                default: try await handle(frame, generation: current)
                }
            }
        } catch is CancellationError { }
        catch { connectionFailed(error, generation: current) }
    }

    private func handle(_ frame: JSON, generation current: UUID) async throws {
        guard current == generation else { return }
        switch frame["type"].string {
        case "ready":
            log.info("Relay ready; saved content key: \(self.session?.dataKey != nil)")
            guard frame["session_id"].string == session?.sessionID, frame["role"].string == "client" else { throw PilotError("Unexpected relay session.") }
            emit(.status("Securing connection…", connected: false))
            // Fresh snapshots are our source of truth; skip old ciphertext and
            // request a signed bootstrap addressed to this independent client.
            try await send(.object(["type": .string("sync"), "after_seq": .number(Double(max(0, frame["next_seq"].int - 1)))]))
            guard current == generation else { return }
            if session?.dataKey == nil { try await requestBootstrap() }
            else { scheduleRefresh() }
        case "sync":
            for update in frame["updates"].array { try consume(update) }
            if frame["presence"] != .null { applyPresence(frame["presence"]) }
        case "update": try consume(frame["update"])
        case "presence": applyPresence(frame["presence"])
        case "ephemeral":
            if let key = session?.dataKey, frame["body"]["kind"].string == "encrypted-daemon-event" {
                publish(NativeRequest.events(try RelayCrypto.decrypt(frame["body"]["envelope"], key: key)))
            }
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

    private func consume(_ update: JSON) throws {
        let body = update["body"]
        if body["t"].string == "session-bootstrap", var saved = session,
           body["material"]["client_public_key"].string == (try RelayIdentity(secret: saved.secret).publicKey) {
            saved.dataKey = try RelayCrypto.bootstrap(body["material"], session: saved)
            try SessionVault.save(saved); session = saved
            scheduleRefresh()
        } else if body["t"].string == "presence" { applyPresence(body["presence"]) }
        else if body["t"].string == "snapshot-invalidated" { scheduleRefresh() }
        else if body["t"].string == "encrypted", let key = session?.dataKey {
            publish(NativeRequest.events(try RelayCrypto.decrypt(body["envelope"], key: key)))
        }
    }

    private func publish(_ events: [JSON]) {
        let live = events.filter { $0["event"]["type"].string != "snapshot" }
        if refreshInFlight {
            bufferedEvents.append(contentsOf: live)
            if bufferedEvents.count > 2048 {
                // A full snapshot will be retried rather than silently dropping
                // deltas. Closing also releases every pending mutation honestly.
                connectionFailed(PilotError("Live updates fell behind. Reconnect to recover."), generation: generation)
                return
            }
        }
        // A sidebar refresh must never pause the selected transcript. Metadata
        // is rebased after the snapshot without replaying text a second time.
        if !live.isEmpty { emit(.events(live)) }
    }

    private func applyPresence(_ presence: JSON) {
        guard presence["daemon_connected"].bool else {
            emit(.status("Computer offline", connected: false)); return
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

    private func scheduleRefresh() {
        let current = generation
        Task { if current == self.generation { await self.refresh() } }
    }
    func refresh() async {
        guard session?.dataKey != nil, !refreshInFlight else { return }
        refreshInFlight = true
        bufferedEvents = []
        let current = generation
        defer { if current == generation { refreshInFlight = false } }
        do {
            let result = try await call("snapshot.current", params: .object([
                "include_archived_threads": .bool(false), "include_thread_plans": .bool(false),
                "include_thread_diffs": .bool(false), "include_agent_skills": .bool(false), "include_workspace_skills": .bool(false)
            ]))
            guard current == generation else { return }
            emit(.snapshot(result))
            emit(.rebase(bufferedEvents)); bufferedEvents = []
            emit(.status("Connected", connected: true))
        } catch {
            guard current == generation else { return }
            bufferedEvents = []
            emit(.error(error.localizedDescription))
        }
    }

    func detail(task: AgentTask, before: String? = nil) async throws -> JSON {
        var params = JSON.object([
            "workspace_id": .string(task.projectID), "thread_id": .string(task.id),
            "mode": .string(before == nil ? "tail" : "before"), "limit": .number(50), "strict_limit": .bool(true),
            "inline_images": .bool(false), "tool_output_bytes": .number(1024), "compact_workspace": .bool(true)
        ])
        if let before { params = params.setting("before_item_id", .string(before)) }
        return try await call("thread.detail", params: params)
    }

    func call(_ method: String, params: JSON) async throws -> JSON {
        let allowed = ["snapshot.current", "thread.detail", "thread.start", "thread.update", "thread.archive", "thread.mark_read", "thread.mark_unread", "thread.unarchive", "thread.fork", "thread.suggestTitle", "thread.goal.set", "thread.goal.clear", "thread.compact", "thread.queue.remove", "thread.queue.edit", "thread.queue.steer", "thread.queue.attachment_preview", "chat.create", "provider.hydrate", "workspace.skills", "workspace.prompts", "thread.item", "turn.start", "turn.interrupt", "preferences.update", "interactive.respond"]
        guard allowed.contains(method), let key = session?.dataKey, socket != nil else {
            throw PilotError("Connect to your computer first.")
        }
        let id = "swift-pilot-\(UUID().uuidString)"
        let current = generation
        log.info("Requesting \(method, privacy: .public)")
        let frame = JSON.object(["type": .string("rpc-call"), "request_id": .string(id), "method": .string(method), "params": try RelayCrypto.encrypt(params, key: key)])
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task {
                do {
                    guard current == self.generation else { throw CancellationError() }
                    try await self.send(frame, requestID: id)
                }
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
        let acks = acknowledgements.values; acknowledgements.removeAll()
        for c in acks { c.resume(throwing: error) }
    }
    private func connectionFailed(_ error: Error, generation current: UUID) {
        guard current == generation else { return }
        emit(.status("Disconnected", connected: false)); emit(.error(error.localizedDescription))
        generation = UUID(); refreshInFlight = false; bufferedEvents = []; bulkSending = false
        log.error("Connection failed: \(error.localizedDescription, privacy: .private)")
        socket?.cancel(with: .goingAway, reason: nil); socket = nil; heartbeat?.cancel()
        failPending(error)
    }
    private func send(_ value: JSON, requestID: String? = nil) async throws {
        guard let socket else { throw PilotError("Relay is disconnected.") }
        let text = try value.wireText()
        let bytes = Data(text.utf8)
        guard bytes.count <= 40 * 1024 * 1024 else { throw PilotError("Message exceeds the relay’s transport limit.") }
        if bytes.count <= 11 * 1024 { try await socket.send(.string(text)); return }
        guard !bulkSending else { throw PilotError("Another large message is still sending. Wait a moment before sending again.") }
        bulkSending = true
        let current = generation
        transferID += 1
        let id = transferID
        defer { if current == generation { bulkSending = false } }
        do {
            for (index, offset) in stride(from: 0, to: bytes.count, by: 11 * 1024).enumerated() {
                guard current == generation else { throw CancellationError() }
                if let requestID, pending[requestID] == nil { throw CancellationError() }
                let part = bytes.subdata(in: offset..<min(offset + 11 * 1024, bytes.count))
                let frame = JSON.object(["type": .string("transport-chunk"), "id": .number(Double(id)), "index": .number(Double(index)), "total": .number(Double(bytes.count)), "data": .string(part.base64EncodedString())])
                let ackKey = "\(id):\(index)"
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    acknowledgements[ackKey] = continuation
                    Task {
                        do { try await socket.send(.string(frame.wireText())) }
                        catch { self.acknowledgements.removeValue(forKey: ackKey)?.resume(throwing: error) }
                    }
                    Task {
                        try? await Task.sleep(for: .seconds(25))
                        self.acknowledgements.removeValue(forKey: ackKey)?.resume(throwing: PilotError("The relay did not acknowledge this message."))
                    }
                }
            }
        } catch {
            if current == generation {
                try? await socket.send(.string(JSON.object(["type": .string("transport-cancel"), "id": .number(Double(id))]).wireText()))
            }
            throw error
        }
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
