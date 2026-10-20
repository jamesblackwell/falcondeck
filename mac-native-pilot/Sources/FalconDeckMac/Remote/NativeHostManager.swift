import Foundation
import Observation

enum NativeHostStatus: String, Codable, Sendable {
    case disconnected, connecting, connected, offline, failed
    var label: String {
        switch self {
        case .disconnected: "Disconnected"
        case .connecting: "Connecting…"
        case .connected: "Connected"
        case .offline: "Computer offline"
        case .failed: "Connection failed"
        }
    }
}

struct NativeRemoteHost: Identifiable, Codable, Equatable, Sendable {
    let id: String
    var name: String
    var relayURL: String
    var sshTarget: String?
    var sshPort: Int
    var enabled: Bool
    var lastConnectedAt: Date?
    var status: NativeHostStatus = .disconnected
    var error: String?

    // Connection state is transient. A relaunch must complete a fresh encrypted
    // handshake and snapshot before any server is reported as connected.
    enum CodingKeys: String, CodingKey { case id, name, relayURL, sshTarget, sshPort, enabled, lastConnectedAt }
}

enum NativeHostEvent: Sendable {
    case status(NativeHostStatus, message: String?)
    case snapshot(JSON)
    case events([JSON])
    case rebase([JSON])
    case removed
}

struct NativeHostUpdate: Sendable {
    let hostID: String
    let event: NativeHostEvent
}

/// One independent authenticated connection per host. Snapshots are disposable
/// in-memory projections of each daemon, never a second conversation store.
@MainActor @Observable final class NativeHostManager {
    static let shared = NativeHostManager()
    private(set) var hosts: [NativeRemoteHost]
    private(set) var snapshots: [String: JSON] = [:]

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let metadataKey = "native.remote.hosts.v1"
    @ObservationIgnored private let credentials: any NativeRemoteCredentialStore
    @ObservationIgnored private let factory: @Sendable (String) -> any NativeRemoteTransport
    @ObservationIgnored private var clients: [String: any NativeRemoteTransport] = [:]
    @ObservationIgnored private var readers: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var reconnects: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var generations: [String: UUID] = [:]
    @ObservationIgnored private var attempts: [String: Int] = [:]
    @ObservationIgnored private var sinks: [UUID: AsyncStream<NativeHostUpdate>.Continuation] = [:]
    @ObservationIgnored private var started = false

    init(defaults: UserDefaults = .standard,
         credentials: any NativeRemoteCredentialStore = NativeRemoteKeychain(),
         factory: (@Sendable (String) -> any NativeRemoteTransport)? = nil) {
        self.defaults = defaults
        self.credentials = credentials
        self.factory = factory ?? { NativeRelayClient(hostID: $0, credentials: credentials) }
        hosts = defaults.data(forKey: "native.remote.hosts.v1").flatMap { try? JSONDecoder().decode([NativeRemoteHost].self, from: $0) } ?? []
    }

    func events() -> AsyncStream<NativeHostUpdate> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<NativeHostUpdate>.makeStream()
        sinks[id] = continuation
        continuation.onTermination = { [weak self] _ in Task { @MainActor in self?.sinks.removeValue(forKey: id) } }
        return stream
    }

    func start() {
        guard !started else { return }
        started = true
        for host in hosts where host.enabled {
            Task { try? await self.connect(hostID: host.id) }
        }
    }

    @discardableResult
    func addHost(name: String, pairingText: String, relay: String = NativePairingInput.defaultRelay,
                 sshTarget: String? = nil, sshPort: Int = 22) async throws -> String {
        let input = try NativePairingInput(text: pairingText, relay: relay)
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw PilotError("Enter a name for this server.") }
        guard (1...65535).contains(sshPort) else { throw PilotError("Enter an SSH port between 1 and 65535.") }
        let id = UUID().uuidString
        hosts.append(NativeRemoteHost(id: id, name: name, relayURL: input.relay.absoluteString,
                                      sshTarget: sshTarget?.trimmingCharacters(in: .whitespacesAndNewlines),
                                      sshPort: sshPort, enabled: true))
        persist()
        try await pair(hostID: id, input: input)
        return id
    }

    func repair(hostID: String, pairingText: String, relay: String = NativePairingInput.defaultRelay) async throws {
        let input = try NativePairingInput(text: pairingText, relay: relay)
        guard let index = hosts.firstIndex(where: { $0.id == hostID }) else { throw PilotError("This server was removed.") }
        hosts[index].relayURL = input.relay.absoluteString
        hosts[index].enabled = true
        persist()
        try await pair(hostID: hostID, input: input)
    }

    private func pair(hostID: String, input: NativePairingInput) async throws {
        reconnects.removeValue(forKey: hostID)?.cancel()
        let client = await transport(hostID)
        let generation = UUID()
        generations[hostID] = generation
        setStatus(hostID, .connecting)
        do {
            try await client.pair(input, connectionID: generation)
        } catch {
            guard generations[hostID] == generation else { throw CancellationError() }
            setStatus(hostID, .failed, message: error.localizedDescription)
            // A claim may already have succeeded before the websocket failed.
            // Keep those credentials and retry; an invalid grant needs repair.
            if (try? credentials.load(hostID: hostID)) != nil { scheduleReconnect(hostID) }
            throw error
        }
    }

    func connect(hostID: String) async throws {
        reconnects.removeValue(forKey: hostID)?.cancel()
        try await connectHost(hostID)
    }

    private func connectHost(_ hostID: String) async throws {
        guard hosts.contains(where: { $0.id == hostID && $0.enabled }) else { return }
        let client = await transport(hostID)
        let generation = UUID()
        generations[hostID] = generation
        setStatus(hostID, .connecting)
        do {
            guard try await client.restore(connectionID: generation) else {
                throw PilotError("Pair this server again to restore its credentials.")
            }
        } catch {
            guard generations[hostID] == generation else { throw CancellationError() }
            setStatus(hostID, .failed, message: error.localizedDescription)
            scheduleReconnect(hostID)
            throw error
        }
    }

    func disconnect(hostID: String) async {
        reconnects.removeValue(forKey: hostID)?.cancel()
        generations[hostID] = UUID()
        try? await clients[hostID]?.disconnect(forget: false)
        setStatus(hostID, .disconnected)
    }

    func setEnabled(hostID: String, enabled: Bool) async {
        guard let index = hosts.firstIndex(where: { $0.id == hostID }) else { return }
        hosts[index].enabled = enabled
        persist()
        if enabled { try? await connect(hostID: hostID) }
        else { await disconnect(hostID: hostID) }
    }

    func update(hostID: String, name: String, sshTarget: String?, sshPort: Int) throws {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, (1...65535).contains(sshPort) else { throw PilotError("Enter a server name and valid SSH port.") }
        guard let index = hosts.firstIndex(where: { $0.id == hostID }) else { throw PilotError("This server was removed.") }
        hosts[index].name = name
        hosts[index].sshTarget = sshTarget?.trimmingCharacters(in: .whitespacesAndNewlines)
        hosts[index].sshPort = sshPort
        persist()
    }

    func remove(hostID: String) async throws {
        // Remove Keychain first so failure remains visible with a retryable row.
        try credentials.remove(hostID: hostID)
        await disconnect(hostID: hostID)
        readers.removeValue(forKey: hostID)?.cancel()
        clients.removeValue(forKey: hostID)
        generations.removeValue(forKey: hostID)
        attempts.removeValue(forKey: hostID)
        snapshots.removeValue(forKey: hostID)
        hosts.removeAll { $0.id == hostID }
        persist()
        emit(hostID, .removed)
    }

    func call(hostID: String, method: String, params: JSON = .object([:])) async throws -> JSON {
        guard hosts.contains(where: { $0.id == hostID && $0.enabled }), let client = clients[hostID] else {
            throw PilotError("Connect to this server first.")
        }
        return try await client.call(method, params: params)
    }

    func request(hostID: String, path: [String], method: String = "GET", query: [URLQueryItem] = [], body: JSON? = nil) async throws -> JSON {
        let rpc = try NativeRemoteRequestRouter.route(path, method: method, query: query, body: body)
        return try await call(hostID: hostID, method: rpc.method, params: rpc.params)
    }

    @discardableResult func addProject(hostID: String, path: String) async throws -> JSON {
        let result = try await call(hostID: hostID, method: "workspace.connect", params: .object(["path": .string(path)]))
        await refresh(hostID: hostID)
        return result
    }

    func refresh(hostID: String? = nil) async {
        if let hostID { await clients[hostID]?.refresh() }
        else {
            await withTaskGroup(of: Void.self) { group in
                for client in clients.values { group.addTask { await client.refresh() } }
            }
        }
    }

    func selectThread(hostID: String, threadID: String?) async {
        await clients[hostID]?.selectThread(threadID)
    }

    func setForeground(_ active: Bool) async {
        await withTaskGroup(of: Void.self) { group in
            for client in clients.values { group.addTask { await client.setForeground(active) } }
        }
        if active {
            for host in hosts where host.enabled && [.disconnected, .failed].contains(host.status) {
                Task { try? await self.connect(hostID: host.id) }
            }
        }
    }

    private func transport(_ hostID: String) async -> any NativeRemoteTransport {
        if let client = clients[hostID] { return client }
        let client = factory(hostID)
        clients[hostID] = client
        let stream = await client.events()
        readers[hostID] = Task { [weak self] in
            for await update in stream {
                guard !Task.isCancelled else { return }
                self?.consume(update, hostID: hostID)
            }
        }
        return client
    }

    private func consume(_ update: NativeRelayUpdate, hostID: String) {
        guard generations[hostID] == update.connectionID,
              hosts.contains(where: { $0.id == hostID && $0.enabled }) else { return }
        switch update.event {
        case .status(let message, connected: let connected):
            let status: NativeHostStatus = connected ? .connected : message == "Computer offline" ? .offline : message == "Disconnected" ? .disconnected : .connecting
            setStatus(hostID, status)
            if connected {
                attempts[hostID] = 0
                reconnects.removeValue(forKey: hostID)?.cancel()
            } else if status == .disconnected { scheduleReconnect(hostID) }
        case .snapshot(let value):
            snapshots[hostID] = value
            emit(hostID, .snapshot(value))
        case .events(let values): emit(hostID, .events(values))
        case .rebase(let values): emit(hostID, .rebase(values))
        case .error(let message):
            if let host = hosts.first(where: { $0.id == hostID }) {
                setStatus(hostID, host.status == .disconnected ? .failed : host.status, message: message)
            }
        }
    }

    private func scheduleReconnect(_ hostID: String) {
        guard reconnects[hostID] == nil, hosts.contains(where: { $0.id == hostID && $0.enabled }) else { return }
        let attempt = attempts[hostID, default: 0]
        attempts[hostID] = min(attempt + 1, 8)
        let delay = min(60.0, pow(2.0, Double(min(attempt, 6))))
        reconnects[hostID] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, !Task.isCancelled else { return }
            self.reconnects[hostID] = nil
            try? await self.connectHost(hostID)
        }
    }

    private func setStatus(_ hostID: String, _ status: NativeHostStatus, message: String? = nil) {
        guard let index = hosts.firstIndex(where: { $0.id == hostID }) else { return }
        hosts[index].status = status
        hosts[index].error = message
        if status == .connected {
            hosts[index].lastConnectedAt = .now
            persist()
        }
        emit(hostID, .status(status, message: message))
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(hosts) { defaults.set(data, forKey: metadataKey) }
    }

    private func emit(_ hostID: String, _ event: NativeHostEvent) {
        for sink in sinks.values { sink.yield(NativeHostUpdate(hostID: hostID, event: event)) }
    }

    nonisolated static func namespace(hostID: String, id: String) -> String { "remote:\(hostID):\(id)" }
    nonisolated static func split(_ id: String) -> (hostID: String?, id: String) {
        guard id.hasPrefix("remote:") else { return (nil, id) }
        let parts = id.dropFirst(7).split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return (nil, id) }
        return (String(parts[0]), String(parts[1]))
    }
}
