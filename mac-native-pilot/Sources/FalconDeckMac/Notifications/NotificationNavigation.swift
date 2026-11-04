import Foundation

/// A record opened in the main column. It names its host, because a banner can
/// open one from a server the window is not showing.
enum NotificationReader: Hashable, Sendable {
    case report(id: String, hostID: String?)
    case review(id: String, hostID: String?)

    var hostID: String? {
        switch self {
        case .report(_, let hostID), .review(_, let hostID): hostID
        }
    }
}

@MainActor extension AppStore {
    /// Marks the record read and goes where it points. Returns false when there
    /// is nowhere to go, so the list stays open to say why.
    @discardableResult
    func openNotification(_ record: NotificationRecord, hostID: String?) -> Bool {
        notifications.dismissMessage()
        Task { await notifications.markRead(record, hostID: hostID) }
        switch record.destination {
        case .report(let id):
            selectNotificationReader(.report(id: id, hostID: hostID))
            return true
        case .review(let id):
            selectNotificationReader(.review(id: id, hostID: hostID))
            return true
        case .thread(_, let taskID):
            guard openNotificationTask(taskID) else {
                notifications.present(message: Self.missingTaskMessage)
                return false
            }
            return true
        case .nothing:
            return false
        }
    }

    /// A banner carries only an id. The record may have been pruned since.
    func openNotification(id: String, hostID: String?) async {
        do {
            openNotification(try await notifications.record(id: id, hostID: hostID), hostID: hostID)
        } catch {
            notifications.present(message: "This notification is no longer available.")
        }
    }

    /// Selects a task that may no longer exist. Ids are already scoped to their host.
    func openNotificationTask(_ id: String) -> Bool {
        guard tasks.contains(where: { $0.id == id }) else { return false }
        Task { await selectTask(id, preservePinScope: false) }
        return true
    }

    static let missingTaskMessage = "This task is no longer available on this computer."

    func closeNotificationReader() async {
        if canNavigateBack { await navigateHistory(-1) }
        else { selectSection("project") }
    }
}
