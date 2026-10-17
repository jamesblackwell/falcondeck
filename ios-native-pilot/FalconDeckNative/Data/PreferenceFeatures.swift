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
        let current = connectionID, previous = preferenceWrite?.task, id = UUID()
        let write = Task {
            // Every native preference control shares this writer, including folders.
            _ = try? await previous?.value
            guard current == connectionID else { throw CancellationError() }
            let revision = preferencesRevision
            let result = try await relay.call("preferences.update", params: patch)
            guard current == connectionID else { throw CancellationError() }
            // Live preference events are newer than this request's frozen response.
            if revision == preferencesRevision { preferences = result }
        }
        preferenceWrite = (id, write)
        defer { if preferenceWrite?.id == id { preferenceWrite = nil } }
        try await write.value
    }
}
