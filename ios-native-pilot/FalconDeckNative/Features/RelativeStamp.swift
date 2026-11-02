import SwiftUI

/// Short relative timestamps for dense task lists: "now", "4m", "3h", "2d", "12 Oct".
enum RelativeStamp {
    static func short(_ value: String, now: Date) -> String? {
        guard let date = ConversationActivity.date(value) else { return nil }
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h" }
        if seconds < 7 * 86400 { return "\(Int(seconds / 86400))d" }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}

/// A shared minute clock keeps every relative timestamp current without a
/// timer per row.
@MainActor @Observable final class MinuteClock {
    static let shared = MinuteClock()
    private(set) var now = Date.now
    @ObservationIgnored private var ticker: Task<Void, Never>?
    func start() {
        guard ticker == nil else { return }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                self?.now = .now
            }
        }
    }
}
