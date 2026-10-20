import Foundation
import OSLog

struct NativeRelayChunkReceiver {
    private var id = 0
    private var index = 0
    private var total = 0
    private var bytes = Data()
    private var started = Date.distantPast
    mutating func receive(_ frame: JSON) throws -> Data? {
        guard let chunkID = frame["id"].optionalInt, let chunkIndex = frame["index"].optionalInt, let size = frame["total"].optionalInt,
              chunkID > 0, size > 0, size <= 40 * 1024 * 1024,
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
    mutating func cancel(id: Int) {
        if id > 0, id == self.id { self = .init() }
    }
}

enum NativeRelayEvent: Sendable {
    case status(String, connected: Bool)
    case snapshot(JSON, rebase: [JSON] = [])
    case events([JSON])
    case rebase([JSON])
    case error(String)
}

struct NativeRelayUpdate: Sendable {
    let connectionID: UUID
    let event: NativeRelayEvent
}

/// Owns networking and cryptography off the UI actor. A fresh daemon snapshot
/// anchors every connection; ordered live events follow it. No history DB or
/// durable replay cursor is added by this client.
actor NativeRelayClient: NativeRemoteTransport {
    private let log = Logger(subsystem: "com.falcondeck.pilot.native", category: "relay")
    private let http: URLSession
    private let hostID: String
    private let credentials: any NativeRemoteCredentialStore

    init(hostID: String, credentials: any NativeRemoteCredentialStore = NativeRemoteKeychain(), http: URLSession = URLSession(configuration: .ephemeral)) {
        self.hostID = hostID
        self.credentials = credentials
        self.http = http
    }
    private let writer = NativeRelayWriter()
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var session: NativeSavedSession?
    private var generation = UUID()
    private var sink: AsyncStream<NativeRelayUpdate>.Continuation?
    private var pending: [String: CheckedContinuation<JSON, Error>] = [:]
    private var requestTasks: [String: Task<Void, Never>] = [:]
    private var rpcReady: Bool?
    private var awaitingBootstrap = true
    private var selectedThread: String?
    private var refreshed = Date.distantPast
    private var refreshInFlight = false
    private var lastReceived = Date.now
    private var lastBootstrapRequest = Date.distantPast
    private var bufferedEvents: [JSON] = []
    private var transferID = 0
    private var bulkSending = false
    private var foreground = true
    private var supportsClientActivity = false
    private var upload: (id: Int, transfer: NativeRelayUpload)?
    private var refreshTask: Task<Void, Never>?
    private var refreshSchedule = NativeRelayRefreshSchedule()

    func selectThread(_ id: String?) { selectedThread = id }
    func setForeground(_ active: Bool) async {
        foreground = active
        guard supportsClientActivity, socket != nil else { return }
        try? await send(.object(["type": .string("client-activity"), "foreground": .bool(active)]))
    }

    func events() -> AsyncStream<NativeRelayUpdate> {
        let (stream, continuation) = AsyncStream<NativeRelayUpdate>.makeStream()
        sink = continuation
        return stream
    }

    private func emit(_ event: NativeRelayEvent) {
        sink?.yield(NativeRelayUpdate(connectionID: generation, event: event))
    }

    private func beginConnection(_ connectionID: UUID) throws {
        try disconnect()
        generation = connectionID
        lastBootstrapRequest = .distantPast
        awaitingBootstrap = true
    }

    func pair(_ input: NativePairingInput, connectionID: UUID) async throws {
        try beginConnection(connectionID)
        let oldIdentity = try credentials.load(hostID: hostID)?.secret
        let identity = try NativeRelayIdentity(secret: oldIdentity)
        let challenge = try await post(input.relay, path: "v1/pairings/challenge", body: .object(["pairing_code": .string(input.code)]))
        guard generation == connectionID else { throw CancellationError() }
        let nonce = challenge["challenge"].string
        guard !nonce.isEmpty else { throw PilotError("Relay did not provide a pairing challenge.") }
        let bundle = try identity.bundle()
        let authority = try NativeRelayIdentity(secret: input.authoritySeed)
        let claim = try await post(input.relay, path: "v1/pairings/claim", body: .object([
            "pairing_code": .string(input.code), "label": .string(Host.current().localizedName.map { "FalconDeck Mac — \($0)" } ?? "FalconDeck Mac"), "client_bundle": bundle,
            "challenge_signature": .string(try identity.sign(["falcondeck-pairing-claim-v1", input.code, nonce])),
            "pairing_authority_signature": .string(try authority.sign(["falcondeck-pairing-authority-client-v1", input.code, nonce, "data_key_v1", "ed25519_v1", try identity.publicKey, try identity.identityKey]))
        ]))
        guard generation == connectionID else { throw CancellationError() }
        try NativeRelayCrypto.verifyClaim(claim, input: input)
        guard !claim["session_id"].string.isEmpty, !claim["client_token"].string.isEmpty, !claim["device_id"].string.isEmpty else { throw PilotError("Relay returned an incomplete connection.") }
        let saved = NativeSavedSession(relay: input.relay, sessionID: claim["session_id"].string, deviceID: claim["device_id"].string,
                                 token: claim["client_token"].string, secret: identity.secret,
                                 daemonKey: claim["daemon_bundle"]["public_key"].string,
                                 daemonIdentity: claim["daemon_bundle"]["identity_public_key"].string)
        try credentials.save(saved, hostID: hostID)
        try await connect(saved)
    }

    func restore(connectionID: UUID) async throws -> Bool {
        try beginConnection(connectionID)
        guard let saved = try credentials.load(hostID: hostID) else { return false }
        try await connect(saved)
        return true
    }

    func disconnect(forget: Bool = false) throws {
        generation = UUID()
        reader?.cancel(); reader = nil; heartbeat?.cancel(); heartbeat = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil; session = nil; rpcReady = nil; refreshInFlight = false; bulkSending = false
        supportsClientActivity = false
        bufferedEvents = []
        failPending(PilotError("The connection closed."))
        if forget { try credentials.remove(hostID: hostID) }
        emit(.status("Disconnected", connected: false))
    }

    private func connect(_ saved: NativeSavedSession) async throws {
        session = saved
        let current = generation
        emit(.status("Connecting…", connected: false))
        let relay = try NativePairingInput.relayURL(saved.relay.absoluteString)
        let ticket = try await post(relay, path: "v1/sessions/\(saved.sessionID)/ws-ticket", token: saved.token)
        guard current == generation else { throw CancellationError() }
        guard !ticket["ticket"].string.isEmpty else { throw PilotError("Relay did not provide a connection ticket.") }
        let ws = http.webSocketTask(with: try NativeRelayEndpoint.updates(relay: relay, sessionID: saved.sessionID, ticket: ticket["ticket"].string))
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
                    if self.awaitingBootstrap { try await self.requestBootstrap() }
                    else if Date.now.timeIntervalSince(self.refreshed) > 300 { self.scheduleRefresh() }
                } catch is CancellationError { return }
                catch { self.connectionFailed(error, generation: current); return }
            }
        }
    }

    private func read(_ ws: URLSessionWebSocketTask, generation current: UUID) async {
        var chunks = NativeRelayChunkReceiver()
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
                case "transport-cancel":
                    if let id = frame["id"].optionalInt { chunks.cancel(id: id) }
                case "transport-ack":
                    if let upload, frame["id"].optionalInt == upload.id, let index = frame["index"].optionalInt {
                        await upload.transfer.acknowledge(index)
                    }
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
            supportsClientActivity = frame["client_activity_supported"].bool
            await setForeground(foreground)
            guard current == generation else { return }
            emit(.status("Securing connection…", connected: false))
            // Fresh snapshots are our source of truth; skip old ciphertext and
            // request a signed bootstrap addressed to this independent client.
            try await send(.object(["type": .string("sync"), "after_seq": .number(Double(max(0, frame["next_seq"].int - 1)))]))
            guard current == generation else { return }
            // Key rotation can happen while this computer sleeps. Require a
            // newly signed bootstrap before using even a saved content key.
            try await requestBootstrap()
        case "sync":
            for update in frame["updates"].array { try consume(update) }
            if frame["presence"] != .null { applyPresence(frame["presence"]) }
        case "update": try consume(frame["update"])
        case "presence": applyPresence(frame["presence"])
        case "ephemeral":
            if frame["body"]["kind"].string == "encrypted-daemon-event" {
                publish(try NativeRelayPayload.decryptEvents(frame["body"]["envelope"], key: session?.dataKey, awaitingBootstrap: awaitingBootstrap))
            }
        case "rpc-result":
            log.info("RPC response received; success: \(frame["ok"].bool)")
            let id = frame["request_id"].string
            guard let continuation = pending.removeValue(forKey: id) else { return }
            requestTasks.removeValue(forKey: id)?.cancel()
            do {
                guard let key = session?.dataKey else { throw PilotError("The encrypted session is not ready.") }
                if frame["ok"].bool {
                    continuation.resume(returning: try NativeRelayCrypto.decrypt(frame["result"], key: key))
                } else {
                    let error = try? NativeRelayCrypto.decrypt(frame["error"], key: key)
                    throw PilotError(error?["message"].string.nonEmptyRelayValue ?? "The computer could not complete this request (\(frame["failure"].string)).")
                }
            } catch { continuation.resume(throwing: error) }
        case "error": throw PilotError(frame["message"].string)
        default: break
        }
    }

    private func consume(_ update: JSON) throws {
        let body = update["body"]
        if body["t"].string == "session-bootstrap", var saved = session,
           body["material"]["client_public_key"].string == (try NativeRelayIdentity(secret: saved.secret).publicKey) {
            saved.dataKey = try NativeRelayCrypto.bootstrap(body["material"], session: saved)
            try credentials.save(saved, hostID: hostID); session = saved
            awaitingBootstrap = false
            scheduleRefresh(urgent: true)
        } else if body["t"].string == "presence" { applyPresence(body["presence"]) }
        else if body["t"].string == "snapshot-invalidated" { scheduleRefresh() }
        else if body["t"].string == "encrypted" {
            publish(try NativeRelayPayload.decryptEvents(body["envelope"], key: session?.dataKey, awaitingBootstrap: awaitingBootstrap))
        }
    }

    private func publish(_ events: [JSON]) {
        // Older relays can ignore compact_index and still push full snapshots.
        // Treat those as invalidations too, so legacy metadata stays fresh.
        if events.contains(where: { $0["event"]["type"].string == "snapshot" }) { scheduleRefresh() }
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
        // is rebased into the snapshot without replaying text a second time.
        if !live.isEmpty { emit(.events(live)) }
    }

    private func applyPresence(_ presence: JSON) {
        let wasReady = rpcReady
        rpcReady = presence["daemon_connected"].bool && presence["daemon_rpc_ready"] != .bool(false)
        guard presence["daemon_connected"].bool else {
            emit(.status("Computer offline", connected: false)); return
        }
        if presence["daemon_rpc_ready"] == .bool(false) { emit(.status("Preparing computer…", connected: false)); return }
        if wasReady != true, session?.dataKey != nil { scheduleRefresh(urgent: true) }
    }

    private func requestBootstrap() async throws {
        guard let saved = session, Date.now.timeIntervalSince(lastBootstrapRequest) > 3 else { return }
        lastBootstrapRequest = .now
        try await send(.object(["type": .string("ephemeral"), "body": .object([
            "kind": .string("request-bootstrap"), "device_id": .string(saved.deviceID),
            "client_bundle": try NativeRelayIdentity(secret: saved.secret).bundle()
        ])]))
    }

    private func scheduleRefresh(urgent: Bool = false) {
        let delay = refreshSchedule.request(urgent: urgent)
        guard !refreshInFlight else { return }
        if urgent { refreshTask?.cancel(); refreshTask = nil }
        guard refreshTask == nil else { return }
        let current = generation
        refreshTask = Task {
            do { try await Task.sleep(for: delay) } catch { return }
            guard current == self.generation else { return }
            self.refreshTask = nil
            await self.refresh()
        }
    }
    func refresh() async {
        guard session?.dataKey != nil, !awaitingBootstrap, rpcReady != false else { return }
        guard !refreshInFlight else { _ = refreshSchedule.request(); return }
        refreshTask?.cancel(); refreshTask = nil
        refreshSchedule.began()
        refreshInFlight = true
        bufferedEvents = []
        let current = generation
        defer {
            if current == generation {
                refreshInFlight = false
                if refreshSchedule.dirty { scheduleRefresh() }
            }
        }
        do {
            let result = try await call("snapshot.current", params: .object([
                "include_archived_threads": .bool(true), "include_thread_plans": .bool(false),
                "include_thread_diffs": .bool(false), "include_agent_skills": .bool(false), "include_workspace_skills": .bool(false)
            ]))
            guard current == generation else { return }
            refreshed = .now
            emit(.snapshot(result, rebase: bufferedEvents)); bufferedEvents = []
            emit(.status("Connected", connected: true))
        } catch {
            guard current == generation else { return }
            bufferedEvents = []
            emit(.error(error.localizedDescription))
        }
    }

    func call(_ method: String, params: JSON) async throws -> JSON {
        guard !method.isEmpty, !awaitingBootstrap, let key = session?.dataKey, socket != nil, rpcReady != false else {
            throw PilotError("Connect to your computer first.")
        }
        let id = "swift-pilot-\(UUID().uuidString)"
        let current = generation
        log.info("Requesting \(method, privacy: .public)")
        let frame = JSON.object(["type": .string("rpc-call"), "request_id": .string(id), "method": .string(method), "params": try NativeRelayCrypto.encrypt(params, key: key)])
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            requestTasks[id] = Task {
                do {
                    guard current == self.generation else { throw CancellationError() }
                    try await self.send(frame, requestID: id)
                    guard current == self.generation, self.pending[id] != nil else { return }
                    // The daemon cannot act until the acknowledged upload is
                    // complete. Give its response a separate deadline, as well
                    // as the bounded transport deadline below.
                    let seconds = ["speech.transcribe", "speech.synthesize", "turn.start", "thread.item"].contains(method) ? 120 : 35
                    try await Task.sleep(for: .seconds(seconds))
                    self.finish(id, error: PilotError("The computer took too long to respond. Pull to refresh or reconnect."))
                }
                catch { self.finish(id, error: error) }
            }
        }
    }
    private func finish(_ id: String, error: Error) {
        requestTasks.removeValue(forKey: id)?.cancel()
        pending.removeValue(forKey: id)?.resume(throwing: error)
    }
    private func failPending(_ error: Error) {
        let continuations = pending.values; pending.removeAll()
        for task in requestTasks.values { task.cancel() }; requestTasks = [:]
        for c in continuations { c.resume(throwing: error) }
        if let upload { Task { await upload.transfer.cancel(error) } }; upload = nil
        refreshTask?.cancel(); refreshTask = nil; refreshSchedule = .init()
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
        let text = try value.relayWireText()
        let bytes = Data(text.utf8)
        guard bytes.count <= 40 * 1024 * 1024 else { throw PilotError("Message exceeds the relay’s transport limit.") }
        if bytes.count <= 11 * 1024 { try await writer.send(text, to: socket); return }
        guard !bulkSending else { throw PilotError("Another large message is still sending. Wait a moment before sending again.") }
        bulkSending = true
        let current = generation
        let deadline = ContinuousClock.now.advanced(by: .seconds(900))
        transferID += 1
        let id = transferID
        defer { if current == generation { bulkSending = false } }
        do {
            let transfer = NativeRelayUpload()
            upload = (id, transfer)
            defer { if current == generation { upload = nil } }
            try await transfer.send(bytes, id: id) { frame in
                try await self.writeChunk(frame, socket: socket, generation: current, requestID: requestID, deadline: deadline)
            }
        } catch {
            if current == generation {
                try? await writer.send(JSON.object(["type": .string("transport-cancel"), "id": .number(Double(id))]).relayWireText(), to: socket, timeout: .seconds(2))
            }
            throw error
        }
    }
    private func writeChunk(_ frame: JSON, socket: URLSessionWebSocketTask, generation current: UUID, requestID: String?, deadline: ContinuousClock.Instant) async throws {
        guard current == generation else { throw CancellationError() }
        if let requestID, pending[requestID] == nil { throw CancellationError() }
        let timeout = min(Duration.seconds(25), ContinuousClock.now.duration(to: deadline))
        try await writer.send(frame.relayWireText(), to: socket, timeout: timeout)
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
            throw PilotError(value?["error"].string.nonEmptyRelayValue ?? "The relay could not complete the connection. Check the address and pairing link.")
        }
        return value
    }
}

/// Foundation can queue a write indefinitely before a WebSocket handshake.
/// Use its callback API so the timeout can resume the caller and close that
/// socket without waiting for a suspended send task to honor cancellation.
actor NativeRelayWriter {
    private var pending: [UUID: (continuation: CheckedContinuation<Void, Error>, timer: Task<Void, Never>)] = [:]

    func send(_ text: String, to socket: URLSessionWebSocketTask, timeout: Duration = .seconds(25)) async throws {
        try await perform(timeout: timeout, start: { completion in
            socket.send(.string(text), completionHandler: completion)
        }, cancel: { socket.cancel(with: .goingAway, reason: nil) })
    }

    func perform(timeout: Duration, start: @Sendable (@escaping @Sendable (Error?) -> Void) -> Void, cancel: @escaping @Sendable () -> Void) async throws {
        let id = UUID()
        try await withCheckedThrowingContinuation { continuation in
            let timer = Task {
                do { try await Task.sleep(for: timeout) } catch { return }
                guard self.pending[id] != nil else { return }
                cancel()
                self.finish(id, error: PilotError("The relay took too long to accept this message. Reconnect to try again."))
            }
            pending[id] = (continuation, timer)
            start { error in Task { await self.finish(id, error: error) } }
        }
    }

    private func finish(_ id: UUID, error: Error?) {
        guard let write = pending.removeValue(forKey: id) else { return }
        write.timer.cancel()
        if let error { write.continuation.resume(throwing: error) }
        else { write.continuation.resume() }
    }
}

extension String {
    var nonEmptyRelayValue: String? { isEmpty ? nil : self }
}


enum NativeRelayPayload {
    static func decryptEvents(_ envelope: JSON, key: Data?, awaitingBootstrap: Bool) throws -> [JSON] {
        // The saved key may have rotated while this Mac was disconnected.
        // Live traffic can arrive before the requested bootstrap; the fresh
        // snapshot after authentication recovers everything skipped here.
        guard !awaitingBootstrap, let key else { return [] }
        return events(try NativeRelayCrypto.decrypt(envelope, key: key))
    }

    static func events(_ payload: JSON) -> [JSON] {
        switch payload["kind"].string {
        case "daemon-event": [payload["event"]]
        case "daemon-events": payload["events"].array
        default: []
        }
    }
}

extension JSON {
    func relayWireText() throws -> String {
        // chunks-v1 reserves the literal type-first prefix before JSON parsing.
        guard case .object(var fields) = self, let type = fields.removeValue(forKey: "type") else {
            return String(decoding: try data(), as: UTF8.self)
        }
        let first = String(decoding: try type.data(), as: UTF8.self)
        if fields.isEmpty { return "{\"type\":\(first)}" }
        let rest = String(decoding: try JSON.object(fields).data().dropFirst(), as: UTF8.self)
        return "{\"type\":\(first),\(rest)"
    }
}
