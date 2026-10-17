import Foundation

@MainActor extension AppModel {
    func synchronizePush() {
        guard !demo, hasSession else { return }
        let session = try? sessionLoader()
        let eventNotifications = preferences["notifications"]["enabled"] != .bool(false)
        let current = connectionID
        Task {
            guard current == connectionID, hasSession, !demo else { return }
            await push.configure(session: session, eventNotifications: eventNotifications)
        }
    }
    func openPendingNotification() async {
        guard let destination = pendingNotification, !demo, connected else { return }
        guard (try? sessionLoader())?.sessionID == destination.sessionID else {
            pendingNotification = nil; error = "This notification belongs to another computer connection."; return
        }
        pendingNotification = nil
        let current = connectionID
        do {
            let target = AgentTask(.object(["workspace_id": .string(destination.workspaceID), "id": .string(destination.threadID)]))
            let result = try await relay.detail(task: target, before: nil)
            guard current == connectionID else { return }
            let raw = result["thread"]
            guard raw["id"].string == destination.threadID, raw["workspace_id"].string == destination.workspaceID else { throw PilotError("This task is no longer available on your computer.") }
            upsertTask(raw); selection = .task(destination.threadID)
        } catch { if current == connectionID { self.error = error.localizedDescription } }
    }
}
