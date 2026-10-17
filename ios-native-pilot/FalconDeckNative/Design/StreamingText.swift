import Foundation
import Observation

/// Coalesces only presentation updates. The transcript retains every wire delta.
@MainActor @Observable final class StreamingText {
    private(set) var value: String?
    @ObservationIgnored private var pending: String?
    @ObservationIgnored private var scheduled: Task<Void, Never>?
    @ObservationIgnored private var lastPaint: ContinuousClock.Instant?
    private let interval: Duration = .milliseconds(50)

    func update(_ text: String, streaming: Bool) {
        if let value, text.utf16.elementsEqual(value.utf16) { cancelPending(); return }
        let now = ContinuousClock.now
        guard streaming, let value, let lastPaint,
              text.utf16.starts(with: value.utf16), now < lastPaint.advanced(by: interval) else {
            cancelPending(); publish(text); return
        }
        pending = text
        // Keep the original deadline; a continuous stream must never debounce
        // itself into silence. Completion and replacements publish immediately.
        guard scheduled == nil else { return }
        let deadline = lastPaint.advanced(by: interval)
        scheduled = Task { @MainActor [weak self] in
            do { try await ContinuousClock().sleep(until: deadline) } catch { return }
            guard !Task.isCancelled, let self else { return }
            self.scheduled = nil
            if let pending = self.pending { self.pending = nil; self.publish(pending) }
        }
    }

    func displayed(_ text: String, streaming: Bool) -> String {
        guard streaming, let value, text.utf16.starts(with: value.utf16) else { return text }
        return value
    }

    func reset() {
        cancelPending(); value = nil; lastPaint = nil
    }

    private func publish(_ text: String) { value = text; lastPaint = .now }
    private func cancelPending() { scheduled?.cancel(); scheduled = nil; pending = nil }
}
