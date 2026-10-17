import Foundation

@MainActor extension AppModel {
    func announceTask(title: String, body: String, taskID: String, workspaceID: String) {
        guard !demo, let session = try? sessionLoader(),
              let destination = NotificationDestination(userInfo: ["sessionId": session.sessionID, "workspaceId": workspaceID, "threadId": taskID]) else { return }
        notifications.announce(title: title, body: body, destination: destination)
    }
    func synchronizePush() {
        // Cached preferences are rendering hints, not permission to change a
        // remote registration. Wait for this connection's authoritative state.
        guard !demo, hasSession, hasLiveSnapshot else { return }
        let session = try? sessionLoader()
        let eventNotifications = preferences["notifications"]["enabled"] != .bool(false)
        let current = connectionID
        Task {
            guard current == connectionID, hasSession, hasLiveSnapshot, !demo else { return }
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
