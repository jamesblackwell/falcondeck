import AppIntents
import Foundation

struct NativeProjectEntity: AppEntity, Sendable {
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Project" }
    static var defaultQuery: NativeProjectQuery { NativeProjectQuery() }
    let projectID: String
    let pairing: String
    let name: String
    let path: String
    var id: String { pairing + ":" + projectID }
    var displayRepresentation: DisplayRepresentation { .init(title: "\(name)", subtitle: "\(path)", image: .init(systemName: "folder")) }
    init(project: Project, pairing: String) {
        projectID = project.id; self.pairing = pairing
        name = project.raw["kind"].string == "casual" ? "Chats" : project.name
        path = project.raw["kind"].string == "casual" ? "" : project.path
    }
}

struct NativeProjectQuery: EntityStringQuery {
    @Dependency var context: NativeIntentContext
    func entities(for identifiers: [String]) async throws -> [NativeProjectEntity] {
        let values = try await context.projects()
        let lookup = Dictionary(values.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return identifiers.compactMap { lookup[$0] }
    }
    func suggestedEntities() async throws -> [NativeProjectEntity] { Array(try await context.projects().prefix(100)) }
    func entities(matching string: String) async throws -> [NativeProjectEntity] {
        try await context.projects().filter { $0.name.localizedStandardContains(string) || $0.path.localizedStandardContains(string) }
    }
}

/// The app registers this dependency at process initialization, before Shortcuts
/// resolves parameters. Queries can use the encrypted pairing cache without a
/// socket or a second project index. A fresh in-app catalog always wins.
@MainActor final class NativeIntentContext {
    let model: AppModel
    private let cacheLoader: @Sendable (SavedSession, URL?) async throws -> [Project]
    private var cached: (pairing: String, expires: Date, projects: [Project])?
    private var loading: (id: UUID, pairing: String, task: Task<[Project], Error>)?
    init(model: AppModel, cacheLoader: @escaping @Sendable (SavedSession, URL?) async throws -> [Project] = { session, root in
        let store = try SessionCacheStore(session: session, root: root)
        return await store.load()?.projects.map(Project.init) ?? []
    }) { self.model = model; self.cacheLoader = cacheLoader }
    func projects() async throws -> [NativeProjectEntity] {
        let catalog = try await catalog()
        guard let pairing = catalog.pairing else { return [] }
        return catalog.projects.filter { !$0.id.isEmpty && $0.raw["kind"].string != "scratch" }
            .map { NativeProjectEntity(project: $0, pairing: pairing) }
    }
    func open(_ destination: NativeShortcutNavigation.Destination, project: NativeProjectEntity? = nil) async throws {
        let catalog = try await catalog()
        guard let pairing = catalog.pairing else { throw PilotError("Pair your computer in Falcon Native first.") }
        if let project {
            guard project.pairing == pairing else { throw PilotError("This project belongs to another computer connection. Choose the project again in Shortcuts.") }
            guard catalog.projects.contains(where: { $0.id == project.projectID }) else { throw PilotError("This project is no longer available. Open Falcon Native to refresh your projects.") }
        }
        if case .newTask(_, let prompt) = destination, prompt.utf8.count > 64 * 1024 {
            throw PilotError("Use a shorter prompt (up to 64 KB).")
        }
        guard model.pendingShortcuts.count < 16 else { throw PilotError("Wait for Falcon Native to finish opening before running more Shortcuts.") }
        model.pendingShortcuts.append(NativeShortcutNavigation(pairing: pairing, destination: destination))
        model.pendingSelection = nil
        model.applyPendingShortcut()
    }
    private func catalog() async throws -> (pairing: String?, projects: [Project]) {
        if model.demo { return (Self.demoPairing, model.sortedProjects) }
        let scope = model.sessionScope, loader = model.sessionLoader
        let session = try await Task.detached(priority: .userInitiated) { try loader() }.value
        guard scope == model.sessionScope else { throw CancellationError() }
        guard let session else { cached = nil; return (nil, []) }
        let pairing = TaskLiveActivity.pairingKey(session)
        if model.hasLiveSnapshot || !model.projects.isEmpty { return (pairing, model.sortedProjects) }
        if let cached, cached.pairing == pairing, cached.expires > .now { return (pairing, cached.projects) }
        let load: (id: UUID, pairing: String, task: Task<[Project], Error>)
        if let current = loading, current.pairing == pairing { load = current }
        else {
            let root = model.sessionCacheRoot, cacheLoader = cacheLoader
            load = (UUID(), pairing, Task.detached(priority: .utility) { try await cacheLoader(session, root) })
            loading = load
        }
        defer { if loading?.id == load.id { loading = nil } }
        let projects = try await load.task.value
        guard scope == model.sessionScope else { throw CancellationError() }
        // A live snapshot can arrive while the disk read is suspended. Even an
        // empty live workspace is authoritative over its previous disk catalog.
        if model.hasLiveSnapshot || !model.projects.isEmpty { return (pairing, model.sortedProjects) }
        let ordered = projects.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        cached = (pairing, .now.addingTimeInterval(30), ordered)
        return (pairing, ordered)
    }
    static let demoPairing = String(repeating: "0", count: 64)
}
