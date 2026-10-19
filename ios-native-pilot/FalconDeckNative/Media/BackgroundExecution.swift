import UIKit

@MainActor protocol BackgroundTaskProviding {
    func begin(_ name: String, expiration: @escaping @MainActor @Sendable () -> Void) -> UIBackgroundTaskIdentifier
    func end(_ id: UIBackgroundTaskIdentifier)
}

@MainActor private struct SystemBackgroundTasks: BackgroundTaskProviding {
    func begin(_ name: String, expiration: @escaping @MainActor @Sendable () -> Void) -> UIBackgroundTaskIdentifier {
        UIApplication.shared.beginBackgroundTask(withName: name) { expiration() }
    }
    func end(_ id: UIBackgroundTaskIdentifier) { UIApplication.shared.endBackgroundTask(id) }
}

/// A finite execution assertion, never an always-on connection. Every caller
/// ends it with defer; expiration cancels network work without deleting audio.
@MainActor final class BackgroundExecution {
    private let provider: any BackgroundTaskProviding
    init(provider: (any BackgroundTaskProviding)? = nil) { self.provider = provider ?? SystemBackgroundTasks() }
    func begin(_ name: String, onExpiration: @escaping @MainActor @Sendable () -> Void = {}) -> BackgroundLease {
        BackgroundLease(provider: provider, name: name, onExpiration: onExpiration)
    }
}

@MainActor final class BackgroundLease {
    private let provider: any BackgroundTaskProviding
    private var identifier = UIBackgroundTaskIdentifier.invalid
    private var finished = false
    private(set) var expired = false
    fileprivate init(provider: any BackgroundTaskProviding, name: String, onExpiration: @escaping @MainActor @Sendable () -> Void) {
        self.provider = provider
        identifier = provider.begin(name) { [weak self] in
            guard let self, !self.finished else { return }
            self.expired = true; self.finish(); onExpiration()
        }
        // Also handles a provider expiring synchronously during begin().
        if finished { endIdentifier() }
    }
    func finish() {
        guard !finished else { return }
        finished = true; endIdentifier()
    }
    private func endIdentifier() {
        guard identifier != .invalid else { return }
        let id = identifier; identifier = .invalid; provider.end(id)
    }
}
