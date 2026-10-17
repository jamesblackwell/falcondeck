import Foundation
import Network

@MainActor final class NetworkMonitor {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.falcondeck.native.network")
    init(changed: @escaping @MainActor @Sendable (Bool) -> Void) {
        monitor.pathUpdateHandler = { path in
            let available = path.status == .satisfied
            Task { @MainActor in changed(available) }
        }
        monitor.start(queue: queue)
    }
    deinit { monitor.cancel() }
}

enum ReconnectDelay {
    static func seconds(attempt: Int) -> Double { min(30, pow(2, Double(max(0, min(attempt, 5))))) }
}
