import Foundation

actor BoundedImageDownload {
    static let shared = BoundedImageDownload()
    func download(_ url: URL, session: URLSession = .shared, maxBytes: Int = 25_000_000) async throws -> Data {
        guard maxBytes > 0 else { throw PilotError("Invalid image display limit.") }
        return try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask { try await Self.stream(url, session: session, maxBytes: maxBytes) }
            group.addTask {
                try await Task.sleep(for: .seconds(30))
                throw PilotError("The image took too long to load. Tap to retry.")
            }
            defer { group.cancelAll() }
            guard let data = try await group.next() else { throw CancellationError() }
            return data
        }
    }
    private static func stream(_ url: URL, session: URLSession, maxBytes: Int) async throws -> Data {
        let (bytes, response) = try await session.bytes(from: url)
        defer { bytes.task.cancel() }
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode), response.expectedContentLength <= maxBytes else { throw PilotError("This image is unavailable or too large to display.") }
        return try await withTaskCancellationHandler {
            var data = Data()
            data.reserveCapacity(min(maxBytes, max(0, Int(response.expectedContentLength))))
            for try await byte in bytes {
                guard data.count < maxBytes else { throw PilotError("This image exceeds the 25 MB display limit.") }
                data.append(byte)
            }
            return data
        } onCancel: { bytes.task.cancel() }
    }
}
