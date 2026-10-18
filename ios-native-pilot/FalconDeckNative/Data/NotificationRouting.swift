import Foundation

@MainActor extension AppModel {
    func announceTask(title: String, body: String, taskID: String, workspaceID: String) {
        guard !demo, let session = try? sessionLoader(),
              let destination = NotificationDestination(userInfo: ["sessionId": session.sessionID, "workspaceId": workspaceID, "threadId": taskID]) else { return }
        notifications.announce(title: title, body: body, destination: destination)
    }
    @discardableResult func synchronizePush() -> Task<Void, Never>? {
        // Cached preferences are rendering hints, not permission to change a
        // remote registration. Wait for this connection's authoritative state.
        guard !demo, hasSession, hasLiveSnapshot else { return nil }
        let loader = sessionLoader
        let current = connectionID, syncID = UUID()
        pushSyncID = syncID
        return Task {
            // Coalesce requests queued by the same snapshot, and reject an
            // older Keychain read if a newer policy won while it was loading.
            guard current == connectionID, syncID == pushSyncID else { return }
            let session = await Task.detached { try? loader() }.value
            guard current == connectionID, syncID == pushSyncID, hasSession, hasLiveSnapshot, !demo else { return }
            let eventNotifications = preferences["notifications"]["enabled"] != .bool(false)
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
