import Foundation
import UserNotifications

@MainActor final class LocalNotifications: NSObject, UNUserNotificationCenterDelegate {
    private let defaults: UserDefaults
    var openTask: ((String) -> Void)?
    var openDestination: ((NotificationDestination) -> Void)?
    var shouldPresent: ((NotificationDestination) -> Bool)?
    init(defaults: UserDefaults = .standard) { self.defaults = defaults; super.init(); UNUserNotificationCenter.current().delegate = self }
    func authorize() async throws -> Bool { try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) }
    func announce(title: String, body: String, taskID: String) {
        guard defaults.bool(forKey: "native.notifications.connected") else { return }
        let content = UNMutableNotificationContent()
        content.title = title; content.body = String(body.prefix(240)); content.sound = .default
        content.userInfo = ["thread_id": taskID]
        let request = UNNotificationRequest(identifier: "native-\(taskID)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void) {
        let destination = NotificationDestination(userInfo: notification.request.content.userInfo)
        Task { @MainActor in
            let present = destination.map { self.shouldPresent?($0) ?? false } ?? true
            completionHandler(present ? [.banner, .sound, .list] : [])
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let id = response.notification.request.content.userInfo["thread_id"] as? String
        let destination = NotificationDestination(userInfo: response.notification.request.content.userInfo)
        Task { @MainActor in if let destination { self.openDestination?(destination) } else if let id { self.openTask?(id) } }
        completionHandler()
    }
}
