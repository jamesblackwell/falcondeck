import Foundation

struct NativeShortcutNavigation: Sendable {
    enum Destination: Sendable { case newTask(projectID: String?, prompt: String), activity }
    let pairing: String
    let destination: Destination
}

@MainActor extension AppModel {
    func applyPendingShortcut() {
        guard !restoringSession, !pendingShortcuts.isEmpty else { return }
        // Shortcuts can finish parameter resolution before startup restores local
        // input. Keep every accepted prompt in order, even if Activity follows it.
        let requests = pendingShortcuts
        pendingShortcuts.removeAll(); pendingSelection = nil
        for request in requests { applyShortcut(request) }
    }
    private func applyShortcut(_ request: NativeShortcutNavigation) {
        let pairing = demo ? NativeIntentContext.demoPairing : (try? sessionLoader()).map(TaskLiveActivity.pairingKey)
        guard pairing == request.pairing else {
            error = "This Shortcut belongs to another computer connection. Choose the project again in Shortcuts."
            return
        }
        switch request.destination {
        case .activity: revealDetail(.activity)
        case .newTask(let projectID, let prompt):
            let currentProject: Project? = {
                if case .task(let id) = selection { return projects.first { $0.id == task(id)?.projectID } }
                return selectedDraftProject
            }()
            let project = projectID.flatMap { id in projects.first { $0.id == id } } ?? (projectID == nil ? currentProject ?? defaultDraftProject : nil)
            guard let project else { error = "This project isn't available on this device. Reconnect to refresh your projects."; return }
            let task = draftTask(project: project, folderID: nil)
            let chat = chat(for: task)
            let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.isEmpty || (!chat.sending && !chat.preparingAttachments && chat.submission == nil) else {
                error = "This draft has a pending operation. Finish it before opening another prompt from Shortcuts."
                return
            }
            if !text.isEmpty { chat.draft = chat.draft.isEmpty ? text : chat.draft + "\n\n" + text }
            revealDetail(.draft(project.id, nil))
        }
    }
}
