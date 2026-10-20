import Foundation

/// Resolve groups and pagination once per view update. Resizing a column must
/// not rebuild the full task scope for each count, section and footer control.
struct NativeTaskNavigationContent {
    struct FolderGroup: Identifiable {
        let folder: NativeProjectFolder
        let count: Int
        let tasks: [AgentTask]
        var id: String { folder.id }
    }

    let count: Int
    let orderedIDs: [String]
    let page: NativeTaskNavigationPage
    let pinned: [AgentTask]
    let pinnedCount: Int
    let folders: [FolderGroup]
    let root: [AgentTask]

    init(tasks: [AgentTask], folders: [NativeProjectFolder], expandedFolderIDs: Set<String>,
         grouped: Bool, limit: Int, selectedID: String?) {
        count = tasks.count
        let projectPins = grouped ? tasks.filter { $0.raw["is_pinned_in_project"].bool } : []
        pinnedCount = projectPins.count
        var claimed = Set(projectPins.map(\.id))
        var folderTasks: [(NativeProjectFolder, [AgentTask])] = []
        var displayOrder = projectPins
        if grouped {
            for folder in folders {
                let ids = folder.taskIDs
                let members = tasks.filter { ids.contains($0.id) && !claimed.contains($0.id) }
                claimed.formUnion(members.map(\.id))
                folderTasks.append((folder, members))
                if expandedFolderIDs.contains(folder.id) { displayOrder.append(contentsOf: members) }
            }
        }
        let rootTasks = tasks.filter { !claimed.contains($0.id) }
        displayOrder.append(contentsOf: rootTasks)
        orderedIDs = displayOrder.map(\.id)
        let page = NativeTaskNavigationPage(orderedIDs: orderedIDs, limit: limit, selectedID: selectedID)
        self.page = page
        let included = page.includedIDs
        pinned = projectPins.filter { included.contains($0.id) }
        self.folders = folderTasks.map { folder, members in
            FolderGroup(folder: folder, count: members.count,
                        tasks: members.filter { included.contains($0.id) })
        }
        root = rootTasks.filter { included.contains($0.id) }
    }
}
