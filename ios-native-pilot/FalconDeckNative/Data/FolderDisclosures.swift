import Foundation
import Observation

/// Folder disclosure is immediate; persist the latest intent serially so a
/// slow acknowledgement cannot undo a second tap or race a newer save.
@MainActor @Observable final class FolderDisclosures {
    private(set) var overrides: [String: Bool] = [:]
    private(set) var saving: Set<String> = []
    @ObservationIgnored private var generation = UUID()

    func isExpanded(_ folder: ProjectFolder) -> Bool { overrides[folder.id] ?? !folder.collapsed }
    func reveal(_ id: String) { overrides[id] = true }
    func reset() { generation = UUID(); overrides = [:]; saving = [] }

    func toggle(_ folder: ProjectFolder, model: AppModel) {
        let id = folder.id
        overrides[id] = !isExpanded(folder)
        guard saving.insert(id).inserted else { return }
        let connection = model.connectionID, generation = generation
        Task {
            defer { if generation == self.generation { saving.remove(id) } }
            while generation == self.generation, connection == model.connectionID, let desired = overrides[id] {
                do { try await model.folderMutation(projectID: folder.projectID, action: "set_collapsed", folderID: id, collapsed: !desired) }
                catch {
                    guard generation == self.generation, connection == model.connectionID else { return }
                    overrides.removeValue(forKey: id); model.error = error.localizedDescription
                    return
                }
                guard generation == self.generation, connection == model.connectionID else { return }
                if overrides[id] == desired { overrides.removeValue(forKey: id); return }
            }
        }
    }
}
