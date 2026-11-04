import Observation
import UIKit
import UserNotifications

/// Where a tapped notification goes. An ordinary push carries a thread. A
/// notification-centre push adds `notificationId`, and a notice adds `reportId`;
/// a notice may have no thread at all, so then the thread fields stay empty.
struct NotificationDestination: Equatable, Sendable {
    let sessionID: String
    let workspaceID: String
    let threadID: String
    /// Set for a review, which opens the inbox and may have no source task.
    let reviewID: String?
    let kind: String?
    let notificationID: String?
    let reportID: String?
    var userInfo: [String: String] {
        var info = ["sessionId": sessionID, "workspaceId": workspaceID, "threadId": threadID]
        if let reviewID { info["reviewId"] = reviewID }
        if let kind { info["kind"] = kind }
        if let notificationID { info["notificationId"] = notificationID }
        if let reportID { info["reportId"] = reportID }
        return info
    }
    /// A notice opens its report, with the Mac asleep or not. So does a record
    /// with nowhere else to go. A review always opens the review.
    var detailTarget: NotificationDetailTarget? {
        guard reviewID == nil, notificationID != nil || reportID != nil, kind == "agent-notice" || reportID != nil || threadID.isEmpty else { return nil }
        return NotificationDetailTarget(notificationID: notificationID, reportID: reportID)
    }
    init?(userInfo: [AnyHashable: Any]) {
        func field(_ key: String) -> String? {
            guard let value = userInfo[key] as? String, !value.isEmpty, value.utf8.count <= 1024, !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
            return value
        }
        func malformed(_ key: String) -> Bool { (userInfo[key] as? String).map { !$0.isEmpty && field(key) == nil } ?? false }
        guard let session = field("sessionId") else { return nil }
        let review = field("reviewId")
        if userInfo["reviewId"] is String, review == nil { return nil }
        if review != nil, malformed("workspaceId") || malformed("threadId") { return nil }
        let workspace = field("workspaceId"), thread = field("threadId"), notification = field("notificationId")
        let report = field("reportId").flatMap { NotificationReportClient.isValid(id: $0) ? $0 : nil }
        let hasThread = workspace != nil && thread != nil
        guard hasThread || review != nil || notification != nil || report != nil else { return nil }
        // A review keeps whatever it has of its source; a half-addressed row keeps nothing.
        sessionID = session; workspaceID = hasThread || review != nil ? workspace ?? "" : ""; threadID = hasThread || review != nil ? thread ?? "" : ""
        reviewID = review; kind = field("kind"); notificationID = notification; reportID = report
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
    private let authorize: @Sendable () async throws -> Bool
    private var version = 0
    private static let choiceKey = "native.notifications.choice"

    init(defaults: UserDefaults = .standard, sync: PushRegistrationSync = PushRegistrationSync(),
         authorize: @escaping @Sendable () async throws -> Bool = { try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) }) {
        self.defaults = defaults; self.sync = sync; self.authorize = authorize
        enabled = defaults.object(forKey: "native.notifications.push") == nil ? defaults.bool(forKey: "native.notifications.connected") : defaults.bool(forKey: "native.notifications.push")
        defaults.set(enabled, forKey: "native.notifications.push")
        defaults.set(enabled, forKey: "native.notifications.connected")
    }

    func setEnabled(_ enabled: Bool) async throws {
        if enabled {
            guard try await authorize() else { throw PilotError("Allow notifications for this app in your device’s Settings.") }
        }
        defaults.set(true, forKey: Self.choiceKey)
        store(enabled)
        if enabled { UIApplication.shared.registerForRemoteNotifications() }
        await reconcile()
    }
    func configure(session: SavedSession?, eventNotifications: Bool = true) async {
        self.session = session; self.eventNotifications = eventNotifications
        if session != nil { await adoptDefault() }
        if enabled { UIApplication.shared.registerForRemoteNotifications() }
        await reconcile()
    }
    /// Push used to stay off until someone found the toggle, so a paired phone
    /// silently received nothing. Ask once when a computer connects. Only an
    /// explicit choice on the toggle may keep it off.
    private func adoptDefault() async {
        guard !enabled, !defaults.bool(forKey: Self.choiceKey) else { return }
        defaults.set(true, forKey: Self.choiceKey)
        if (try? await authorize()) == true { store(true) }
    }
    private func store(_ enabled: Bool) {
        self.enabled = enabled
        defaults.set(enabled, forKey: "native.notifications.push")
        defaults.set(enabled, forKey: "native.notifications.connected")
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
