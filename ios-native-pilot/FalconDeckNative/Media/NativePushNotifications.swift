import Observation
import UIKit
import UserNotifications

struct NotificationDestination: Equatable, Sendable {
    let sessionID: String
    let workspaceID: String
    let threadID: String
    init?(userInfo: [AnyHashable: Any]) {
        guard let session = userInfo["sessionId"] as? String, let workspace = userInfo["workspaceId"] as? String, let thread = userInfo["threadId"] as? String,
              [session, workspace, thread].allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 && !$0.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) }) else { return nil }
        sessionID = session; workspaceID = workspace; threadID = thread
    }
}

@MainActor @Observable final class NativePushNotifications {
    static let shared = NativePushNotifications()
    private(set) var enabled: Bool
    private(set) var status: String = "Connect a computer to register background notifications."
    private(set) var registered = false
    private var token: String?
    private var session: SavedSession?
    private var eventNotifications = true
    private let sync: PushRegistrationSync
    private let defaults: UserDefaults
    private var version = 0

    init(defaults: UserDefaults = .standard, sync: PushRegistrationSync = PushRegistrationSync()) {
        self.defaults = defaults; self.sync = sync
        enabled = defaults.object(forKey: "native.notifications.push") == nil ? defaults.bool(forKey: "native.notifications.connected") : defaults.bool(forKey: "native.notifications.push")
        defaults.set(enabled, forKey: "native.notifications.push")
        defaults.set(enabled, forKey: "native.notifications.connected")
    }

    func setEnabled(_ enabled: Bool) async throws {
        if enabled {
            guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) else { throw PilotError("Allow notifications for Falcon Native in this device’s Settings.") }
        }
        self.enabled = enabled
        defaults.set(enabled, forKey: "native.notifications.push")
        defaults.set(enabled, forKey: "native.notifications.connected")
        if enabled { UIApplication.shared.registerForRemoteNotifications() }
        await reconcile()
    }
    func configure(session: SavedSession?, eventNotifications: Bool = true) async {
        self.session = session; self.eventNotifications = eventNotifications
        if enabled { UIApplication.shared.registerForRemoteNotifications() }
        await reconcile()
    }
    func registered(_ token: Data) {
        self.token = token.map { String(format: "%02x", $0) }.joined()
        Task { await reconcile() }
    }
    func forget(session old: SavedSession?) async {
        session = nil; version += 1; registered = false
        let current = version
        if let old {
            let target = PushTarget(session: old, token: nil, topic: "", environment: "", enabled: false)
            let result = await sync.forget(target)
            guard current == version else { return }
            status = result.message
        } else { await reconcile() }
    }
    func registrationFailed() { version += 1; status = "Apple device registration failed. Check your internet connection, then reopen Notifications to retry." }
    private func reconcile() async {
        version += 1; let current = version
        let target = session.map { PushTarget(session: $0, token: token, topic: Bundle.main.bundleIdentifier ?? "", environment: Bundle.main.object(forInfoDictionaryKey: "NativePushEnvironment") as? String ?? "", enabled: enabled && eventNotifications) }
        let result = await sync.update(target)
        guard current == version else { return }
        registered = session != nil && [.registered, .registeredWithPendingCleanup].contains(result)
        status = session == nil ? "Connect a computer to register background notifications." : result.message
    }
}

@MainActor final class NativeAppDelegate: NSObject, UIApplicationDelegate {
    nonisolated func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in NativePushNotifications.shared.registered(deviceToken) }
    }
    nonisolated func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        Task { @MainActor in NativePushNotifications.shared.registrationFailed() }
    }
}
