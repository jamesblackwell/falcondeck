import Foundation

extension JSON {
    func merging(_ patch: JSON) -> JSON {
        guard case .object(var original) = self, case .object(let updates) = patch else { return patch }
        for (key, value) in updates { original[key] = original[key]?.merging(value) ?? value }
        return .object(original)
    }
}

@MainActor extension AppModel {
    func updatePreferences(_ patch: JSON) async throws {
        if demo { preferences = preferences.merging(patch); return }
        let current = connectionID
        let result = try await relay.call("preferences.update", params: patch)
        guard current == connectionID else { throw CancellationError() }
        preferences = result
    }
}
