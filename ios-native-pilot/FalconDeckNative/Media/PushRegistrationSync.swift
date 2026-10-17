import Foundation

protocol PushHTTP: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, Int)
}

final class PushURLSession: NSObject, PushHTTP, URLSessionTaskDelegate, @unchecked Sendable {
    func send(_ request: URLRequest) async throws -> (Data, Int) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 20
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard data.count <= 64 * 1024, let response = response as? HTTPURLResponse else { throw PilotError("Invalid push registration response.") }
        return (data, response.statusCode)
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

struct PushTarget: Sendable {
    let session: SavedSession
    let token: String?
    let topic: String
    let environment: String
    let enabled: Bool
    var identity: String { session.relay.absoluteString + "|" + session.sessionID + "|" + session.deviceID }
    func matches(_ other: PushTarget) -> Bool {
        identity == other.identity && session.token == other.session.token && token == other.token && topic == other.topic && environment == other.environment && enabled == other.enabled
    }
}

enum PushSyncStatus: Equatable, Sendable {
    case disabled, waitingForToken, registered, unavailable, failed
    var message: String {
        switch self {
        case .disabled: "Push notifications are off on this device."
        case .waitingForToken: "Waiting for this device to register with Apple."
        case .registered: "Background notifications are registered with your relay."
        case .unavailable: "This relay does not support this app’s native notifications. Alerts while connected remain available."
        case .failed: "Push registration failed. It will retry when you reconnect. If forgetting this computer, revoke this device from desktop Remote Access settings."
        }
    }
}

/// Serializes on/off, token rotation and connection changes. A late register
/// completes before the subsequent unregister, so disabling cannot resurrect it.
actor PushRegistrationSync {
    private let http: any PushHTTP
    private var desired: PushTarget?
    private var revision = 0
    private var worker: Task<Void, Never>?
    private var known: PushTarget?
    private var pendingClears: [String: PushTarget] = [:]
    private var status = PushSyncStatus.disabled
    init(http: any PushHTTP = PushURLSession()) { self.http = http }

    func update(_ target: PushTarget?) async -> PushSyncStatus {
        desired = target; revision += 1
        if worker == nil { worker = Task { await self.drain() } }
        await worker?.value
        return status
    }
    private func drain() async {
        defer { worker = nil }
        var handled = -1
        while handled != revision {
            let current = revision, target = desired
            if let known, known.identity != target?.identity {
                if known.enabled { pendingClears[known.identity] = known }
                self.known = nil
            }
            for (identity, old) in Array(pendingClears) {
                do { try await post(old, registration: nil); pendingClears.removeValue(forKey: identity) } catch { }
            }
            let next: PushSyncStatus
            do { next = try await synchronize(target, revision: current) } catch { next = .failed }
            if current == revision { status = pendingClears.isEmpty ? next : .failed }
            handled = current
        }
    }
    private func synchronize(_ target: PushTarget?, revision current: Int) async throws -> PushSyncStatus {
        guard let target else { return .disabled }
        if let known, known.matches(target) { return target.enabled ? .registered : .disabled }
        if !target.enabled {
            do { try await post(target, registration: nil) }
            catch PushEndpointError.unavailable { known = target; return .disabled }
            known = target; return .disabled
        }
        guard let token = target.token else { return .waitingForToken }
        guard !target.topic.isEmpty, ["sandbox", "production"].contains(target.environment) else { return .unavailable }
        let request = URLRequest(url: target.session.relay.appending(path: "v1/push-capabilities"))
        let (data, status) = try await http.send(request)
        guard current == revision else { return .disabled }
        if status == 404 { return .unavailable }
        guard status == 200 else { throw PilotError("Push capability check failed.") }
        let capabilities = try JSONDecoder().decode(JSON.self, from: data)
        guard capabilities["apns"].array.contains(where: { $0["topic"].string == target.topic && $0["environment"].string == target.environment }) else { return .unavailable }
        try await post(target, registration: .object(["provider": .string("apns"), "token": .string(token), "topic": .string(target.topic), "environment": .string(target.environment)]))
        known = target
        return .registered
    }
    private func post(_ target: PushTarget, registration: JSON?) async throws {
        var request = URLRequest(url: target.session.relay.appending(path: "v1/sessions/\(target.session.sessionID)/devices/\(target.session.deviceID)/push-registration"))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(target.session.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(JSON.object(["registration": registration ?? .null]))
        let (_, status) = try await http.send(request)
        if status == 404 { throw PushEndpointError.unavailable }
        guard status == 200 else { throw PilotError("Push registration was rejected.") }
    }
}
private enum PushEndpointError: Error { case unavailable }
