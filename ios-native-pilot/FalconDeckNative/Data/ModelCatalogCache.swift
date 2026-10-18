import Foundation

/// Last-known metadata for one harness, scoped by the encrypted pairing cache.
/// Never copied into authoritative workspace capabilities or RPC state.
struct CachedModelCatalog: Codable, Sendable, Equatable {
    var projectID: String
    var provider: String
    var models: [JSON]
    var updatedAt = Date.now

    static let maxEntries = 32
    static let maxModels = 1000
    static let maxCatalogBytes = 256 * 1024
    static let maxTotalBytes = 1024 * 1024

    static func bounded(_ entries: [Self]) -> [Self] {
        var remaining = maxTotalBytes, result: [Self] = []
        for entry in entries.sorted(by: { $0.updatedAt > $1.updatedAt }) {
            guard result.count < maxEntries, !entry.models.isEmpty, entry.models.count <= maxModels,
                  let data = try? JSONEncoder().encode(entry), data.count <= maxCatalogBytes, data.count <= remaining,
                  !result.contains(where: { $0.projectID == entry.projectID && $0.provider == entry.provider }) else { continue }
            remaining -= data.count; result.append(entry)
        }
        return result
    }
}

@MainActor extension AppModel {
    func effectiveModels(projectID: String, provider: String) -> [AgentModel] {
        let live = projects.first { $0.id == projectID }?.models(for: provider) ?? []
        if !live.isEmpty { return live }
        return modelCatalogCache.first { $0.projectID == projectID && $0.provider == provider }?.models.map { AgentModel(raw: $0) } ?? []
    }

    func rememberModelCatalogs() {
        // Only remember nonempty lists. An empty lazy catalog during reconnect
        // must not erase the last useful picker, as in the Expo client.
        for project in projects {
            for provider in project.providers {
                if let catalog = composerCatalogs[project.id + ":" + provider], catalog.modelsLoading, project.agent(provider)["models_loading"].bool {
                    catalog.modelsLoadingObserved = true
                }
                let models = project.models(for: provider).map(\.raw)
                guard !models.isEmpty, models.count <= CachedModelCatalog.maxModels else { continue }
                if let index = modelCatalogCache.firstIndex(where: { $0.projectID == project.id && $0.provider == provider }) {
                    if modelCatalogCache[index].models != models { modelCatalogCache[index] = CachedModelCatalog(projectID: project.id, provider: provider, models: models) }
                } else { modelCatalogCache.append(CachedModelCatalog(projectID: project.id, provider: provider, models: models)) }
            }
        }
        if modelCatalogCache.count > CachedModelCatalog.maxEntries {
            modelCatalogCache = Array(modelCatalogCache.sorted { $0.updatedAt > $1.updatedAt }.prefix(CachedModelCatalog.maxEntries))
        }
    }
}
