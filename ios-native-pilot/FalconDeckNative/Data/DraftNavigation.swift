import Foundation

struct ConversationOrigin {
    let selection: Destination?
    let contentID: UUID
}

@MainActor extension AppModel {
    var conversationOrigin: ConversationOrigin { ConversationOrigin(selection: selection, contentID: detailContentID) }
    var selectedConversation: AgentTask? {
        switch selection {
        case .task(let id): task(id)
        case .draft(let id, let folder): projects.first { $0.id == id }.map { draftTask(project: $0, folderID: folder) }
        case .projects, nil: defaultDraftProject.map { draftTask(project: $0, folderID: nil) }
        default: nil
        }
    }
    var defaultDraftProject: Project? {
        sortedProjects.first { $0.raw["kind"].string == "casual" } ?? sortedProjects.first
    }
    var selectedDraftProject: Project? {
        switch selection {
        case .draft(let id, _): projects.first { $0.id == id }
        case .projects, nil: defaultDraftProject
        default: nil
        }
    }
    var isNewConversation: Bool {
        switch selection { case .draft, .projects, nil: true; default: false }
    }
    /// Opening an already selected draft must also reveal the compact detail
    /// column. Selection equality alone cannot express a navigation request.
    func revealDetail(_ destination: Destination) {
        selection = destination; detailRequestID = UUID()
    }
    func selectDraftProject(_ id: String) {
        guard isNewConversation, projects.contains(where: { $0.id == id }) else { return }
        let folder: String?
        if case .draft(let previous, let currentFolder) = selection, previous == id { folder = currentFolder }
        else { folder = nil }
        // Like Expo, input belongs to the project/folder's draft. Switching
        // targets never copies over another project's text or harness choices.
        revealDetail(.draft(id, folder))
    }
}
