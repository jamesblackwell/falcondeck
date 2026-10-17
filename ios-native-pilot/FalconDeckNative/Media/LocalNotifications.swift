import Foundation
import UserNotifications

@MainActor final class LocalNotifications: NSObject, UNUserNotificationCenterDelegate {
    var openTask: ((String) -> Void)?
    override init() { super.init(); UNUserNotificationCenter.current().delegate = self }
    func authorize() async throws -> Bool { try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) }
    func announce(title: String, body: String, taskID: String) {
        guard UserDefaults.standard.bool(forKey: "native.notifications.connected") else { return }
        let content = UNMutableNotificationContent()
        content.title = title; content.body = String(body.prefix(240)); content.sound = .default
        content.userInfo = ["thread_id": taskID]
        let request = UNNotificationRequest(identifier: "native-\(taskID)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) { completionHandler([.banner, .sound, .list]) }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["thread_id"] as? String
        Task { @MainActor in if let id { self.openTask?(id) } }
        completionHandler()
    }
}
