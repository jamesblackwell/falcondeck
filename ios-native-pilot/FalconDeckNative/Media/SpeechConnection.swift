import Foundation

/// Recording and playback have a session lifetime, independent of a particular
/// relay socket. Wait briefly for reconnect without losing captured audio or
/// routing it to a newly paired computer.
@MainActor enum SpeechConnection {
    static func waitUntilReady(isReady: () -> Bool, isCurrent: () -> Bool, onWait: () -> Void = {}, wait: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) async throws {
        for _ in 0..<120 {
            try Task.checkCancellation()
            guard isCurrent() else { throw CancellationError() }
            if isReady() { return }
            onWait()
            try await wait(.milliseconds(250))
        }
        throw PilotError("Your computer is still reconnecting. Try again when connected.")
    }
}
