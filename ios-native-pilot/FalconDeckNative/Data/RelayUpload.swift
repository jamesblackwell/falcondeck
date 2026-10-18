import Foundation

/// Same chunks-v1 wire format as Expo, with sixteen chunks in flight instead
/// of one round trip per 11 KiB. The owner still serializes bulk transfers.
actor RelayUpload {
    static let chunkBytes = 11 * 1024
    static let window = 16
    private var sent = 0
    private var acknowledged = 0
    private var failure: (any Error)?
    private var waiter: (id: UUID, continuation: CheckedContinuation<Void, Error>, timer: Task<Void, Never>)?
    private let progressTimeout: Duration

    init(progressTimeout: Duration = .seconds(25)) { self.progressTimeout = progressTimeout }

    func acknowledge(_ index: Int) {
        // WebSockets preserve ACK order. Ignore old/unsent ACKs; neither can
        // grant credit or keep a stalled transfer alive.
        guard index == acknowledged, index < sent, failure == nil else { return }
        acknowledged += 1
        resume()
    }
    func cancel(_ error: any Error = CancellationError()) {
        failure = error
        resume(error)
    }
    private func resume(_ error: (any Error)? = nil) {
        guard let waiter else { return }
        self.waiter = nil; waiter.timer.cancel()
        if let error { waiter.continuation.resume(throwing: error) }
        else { waiter.continuation.resume() }
    }
    private func waitForProgress(until deadline: ContinuousClock.Instant) async throws {
        if let failure { throw failure }
        let id = UUID(), timeout = min(progressTimeout, ContinuousClock.now.duration(to: deadline))
        try await withCheckedThrowingContinuation { continuation in
            let timer = Task {
                do { try await Task.sleep(for: timeout) } catch { return }
                guard self.waiter?.id == id else { return }
                self.cancel(PilotError("The relay did not acknowledge this message."))
            }
            waiter = (id, continuation, timer)
        }
    }
    func send(_ bytes: Data, id: Int, write: @Sendable (JSON) async throws -> Void) async throws {
        try await withTaskCancellationHandler {
            try await sendChunks(bytes, id: id, write: write)
        } onCancel: { Task { await self.cancel() } }
    }
    private func sendChunks(_ bytes: Data, id: Int, write: @Sendable (JSON) async throws -> Void) async throws {
        let total = (bytes.count + Self.chunkBytes - 1) / Self.chunkBytes
        let deadline = ContinuousClock.now.advanced(by: .seconds(900))
        do {
            while acknowledged < total {
                if let failure { throw failure }
                try Task.checkCancellation()
                guard ContinuousClock.now < deadline else { throw PilotError("The upload took too long. Try a smaller attachment.") }
                if sent < total && sent - acknowledged < Self.window {
                    let index = sent, offset = index * Self.chunkBytes
                    let part = bytes.subdata(in: offset..<min(offset + Self.chunkBytes, bytes.count))
                    // Register before suspending: a fast ACK can arrive while
                    // Foundation is still completing the write callback.
                    sent += 1
                    try await write(.object(["type": .string("transport-chunk"), "id": .number(Double(id)), "index": .number(Double(index)), "total": .number(Double(bytes.count)), "data": .string(part.base64EncodedString())]))
                } else { try await waitForProgress(until: deadline) }
            }
        } catch { cancel(error); throw error }
    }
}

struct RelayRefreshSchedule {
    private(set) var dirty = false
    private var lastStarted = Date.distantPast
    mutating func request(now: Date = .now, urgent: Bool = false) -> Duration {
        dirty = true
        return urgent ? .zero : .seconds(max(1, 10 - now.timeIntervalSince(lastStarted)))
    }
    mutating func began(now: Date = .now) { dirty = false; lastStarted = now }
}

enum NativeRelayEndpoint {
    static func updates(relay: URL, sessionID: String, ticket: String) throws -> URL {
        guard var parts = URLComponents(url: relay.appending(path: "v1/updates/ws"), resolvingAgainstBaseURL: false) else { throw PilotError("Invalid relay address.") }
        parts.scheme = relay.scheme == "https" ? "wss" : "ws"
        parts.queryItems = [URLQueryItem(name: "session_id", value: sessionID), URLQueryItem(name: "ticket", value: ticket), URLQueryItem(name: "transport", value: "chunks-v1"), URLQueryItem(name: "compact_index", value: "true")]
        guard let url = parts.url else { throw PilotError("Invalid relay address.") }
        return url
    }
}
