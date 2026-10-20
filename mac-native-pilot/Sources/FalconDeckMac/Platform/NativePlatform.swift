import AppKit
import CoreGraphics
import Foundation
import Observation
import UserNotifications

struct NativeAttentionNotice: Equatable {
    let key: String
    let kind: String
    let title: String
    let body: String
    let projectID: String
    let taskID: String
}

/// Native notification delivery is a projection of daemon events, not history.
/// Seed each host's first snapshot quietly, then deduplicate by turn/request.
@MainActor @Observable final class NativePlatform: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NativePlatform()
    private(set) var permission = "default"
    private(set) var desktopPresent = false
    private(set) var notificationError: String?

    typealias NotificationRoute = @MainActor (String?, String, String) async -> Void
    @ObservationIgnored private weak var store: AppStore?
    @ObservationIgnored private var currentHost: @MainActor () -> String? = { nil }
    @ObservationIgnored private var route: NotificationRoute?
    @ObservationIgnored private var center: UNUserNotificationCenter?
    @ObservationIgnored private var heartbeat: Task<Void, Never>?
    @ObservationIgnored private var hosts: [String: AttentionHost] = [:]
    @ObservationIgnored private var pendingFlushes: Set<String> = []
    @ObservationIgnored private var delivered: Set<String> = []
    @ObservationIgnored private var deliveredOrder: [String] = []
    @ObservationIgnored private var focusObservers: [NSObjectProtocol] = []
    @ObservationIgnored private var lastInteraction = Date.distantPast

    private final class AttentionHost {
        var tasks: [String: JSON] = [:]
        var requests: [JSON] = []
        var preferences: JSON = .null
        var seeded = false
        var dirtyTaskIDs: Set<String> = []
        var awaitingTaskIDs: Set<String> = []
    }

    func attach(store: AppStore, currentHost: @escaping @MainActor () -> String? = { nil }, route: NotificationRoute? = nil) {
        self.store = store
        self.currentHost = currentHost
        self.route = route
        if center == nil, Bundle.main.bundleURL.pathExtension == "app", Bundle.main.bundleIdentifier != nil {
            center = UNUserNotificationCenter.current()
            center?.delegate = self
        }
        guard heartbeat == nil else { return }
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification] {
            focusObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    if NSApp.isActive { self?.lastInteraction = Date() }
                    self?.samplePresence()
                    await self?.refreshPermission()
                }
            })
        }
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                self?.samplePresence()
                await self?.refreshPermission()
                do { try await Task.sleep(for: .seconds(15)) }
                catch { return }
            }
        }
    }

    func refreshPermission() async {
        guard let center else { return }
        permission = Self.permissionName((await center.notificationSettings()).authorizationStatus)
    }

    func requestPermission() async {
        guard let center else { return }
        do {
            _ = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            notificationError = nil
        } catch { notificationError = error.localizedDescription }
        await refreshPermission()
    }

    /// Call before applying each envelope. Pass the originating host for remote
    /// events, even when a different host is currently selected in the window.
    func handle(_ envelope: JSON, hostID: String? = nil) {
        let hostKey = hostID ?? "local"
        let event = envelope["event"]
        let host = hosts[hostKey] ?? AttentionHost()
        switch event["type"].string {
        case "snapshot":
            let snapshot = event["snapshot"]
            host.tasks = Dictionary(snapshot["threads"].array.filter { !$0["id"].string.isEmpty }.map { ($0["id"].string, $0) }, uniquingKeysWith: { _, newer in newer })
            host.requests = snapshot["interactive_requests"].array
            host.preferences = snapshot["preferences"]["notifications"]
            host.dirtyTaskIDs = Set(host.tasks.keys)
            host.awaitingTaskIDs = []
            if !host.seeded {
                host.seeded = true
                for task in host.tasks.values { seed(task: task, host: host, hostKey: hostKey) }
            }
        case "thread-started", "thread-updated":
            let task = event["thread"]
            let id = task["id"].string
            guard !id.isEmpty else { return }
            if let previous = host.tasks[id], previous["updated_at"].string > task["updated_at"].string { return }
            host.tasks[id] = task
            host.dirtyTaskIDs.insert(id)
        case "interactive-request":
            let request = event["request"]
            host.requests.removeAll { $0["request_id"] == request["request_id"] }
            host.requests.append(request)
            host.dirtyTaskIDs.insert(request["thread_id"].string)
        case "conversation-item-added", "conversation-item-updated":
            let item = event["item"]
            guard item["kind"].string == "interactive_request", item["resolved"].bool else { return }
            host.requests.removeAll { $0["request_id"] == item["request"]["request_id"] }
            host.dirtyTaskIDs.insert(item["request"]["thread_id"].string.nonempty ?? envelope["thread_id"].string)
        case "turn-end":
            let taskID = envelope["thread_id"].string
            host.requests.removeAll { $0["thread_id"].string == taskID }
            host.dirtyTaskIDs.insert(taskID)
            let status = event["status"].string
            if !["failed", "error", "interrupted", "cancelled", "canceled"].contains(status), host.seeded {
                let key = "\(hostKey):sound:\(taskID):\(event["turn_id"].string)"
                if remember(key), NativePreferences.shared.soundEnabled {
                    playSound(named: NativePreferences.shared.soundName)
                }
            }
        case "preferences-updated":
            host.preferences = event["preferences"]["notifications"]
            // Turning notifications back on must not replay existing attention.
            for task in host.tasks.values { seed(task: task, host: host, hostKey: hostKey) }
        default: return
        }
        hosts[hostKey] = host
        scheduleFlush(hostKey)
    }

    func playSound(named name: String) {
        NativeCompletionSound.play(named: name)
    }

    static func notice(task: JSON, requests: [JSON]) -> NativeAttentionNotice? {
        guard !task["is_archived"].bool else { return nil }
        let projectID = task["workspace_id"].string
        let taskID = task["id"].string
        guard !taskID.isEmpty, !projectID.isEmpty else { return nil }
        let title = task["title"].string.nonempty ?? "FalconDeck task"
        let attention = task["attention"]
        let unread = attention["unread"].bool || attention["last_agent_activity_seq"].int > attention["last_read_seq"].int
        let related = requests.filter { $0["workspace_id"].string == projectID && $0["thread_id"].string == taskID }
        let turn = task["latest_turn_id"].string.nonempty ?? String(attention["last_agent_activity_seq"].int)
        if task["status"].string == "error" || attention["level"].string == "error" {
            guard unread else { return nil }
            return .init(key: "error:\(turn)", kind: "notify_on_error", title: title, body: "The latest run ended with an error.", projectID: projectID, taskID: taskID)
        }
        if !related.isEmpty || attention["pending_approval_count"].int + attention["pending_question_count"].int > 0 {
            let ids = related.map { $0["request_id"].string }.sorted().joined(separator: ",")
            return .init(key: "input:\(ids.nonempty ?? String(attention["last_agent_activity_seq"].int))", kind: "notify_on_input_required", title: title, body: "The agent needs a response in this task.", projectID: projectID, taskID: taskID)
        }
        let working = task["status"].string == "running" || task["status"].string == "idle" && attention["background_task_count"].int > 0
        guard !working, unread else { return nil }
        return .init(key: "complete:\(turn)", kind: "notify_on_turn_complete", title: title, body: "The latest turn finished.", projectID: projectID, taskID: taskID)
    }

    private func scheduleFlush(_ hostKey: String) {
        guard pendingFlushes.insert(hostKey).inserted else { return }
        Task { [weak self] in
            await Task.yield()
            self?.pendingFlushes.remove(hostKey)
            self?.flush(hostKey)
        }
    }

    private func flush(_ hostKey: String) {
        guard let host = hosts[hostKey], host.seeded else { return }
        let hostID = hostKey == "local" ? nil : hostKey
        let dirty = host.dirtyTaskIDs
        host.dirtyTaskIDs = []
        for taskID in dirty {
            host.awaitingTaskIDs.remove(taskID)
            guard let task = host.tasks[taskID], let notice = Self.notice(task: task, requests: host.requests) else { continue }
            if notice.kind == "notify_on_input_required" { host.awaitingTaskIDs.insert(taskID) }
            let key = "\(hostKey):\(notice.projectID):\(notice.taskID):\(notice.key)"
            guard remember(key) else { continue }
            guard Self.enabled("enabled", in: host.preferences), Self.enabled(notice.kind, in: host.preferences) else { continue }
            if !isViewed(notice, hostID: hostID) { Task { await deliver(notice, hostID: hostID) } }
        }
        let pending = hosts.values.reduce(0) { $0 + $1.awaitingTaskIDs.count }
        NSApp.dockTile.badgeLabel = pending > 0 ? String(pending) : nil
    }

    private func seed(task: JSON, host: AttentionHost, hostKey: String) {
        if let notice = Self.notice(task: task, requests: host.requests) {
            _ = remember("\(hostKey):\(notice.projectID):\(notice.taskID):\(notice.key)")
        }
    }

    @discardableResult private func remember(_ key: String) -> Bool {
        guard delivered.insert(key).inserted else { return false }
        deliveredOrder.append(key)
        if deliveredOrder.count > 8192 {
            for old in deliveredOrder.prefix(2048) { delivered.remove(old) }
            deliveredOrder.removeFirst(2048)
        }
        return true
    }

    private static func enabled(_ key: String, in preferences: JSON) -> Bool {
        if case .bool(let enabled) = preferences[key] { return enabled }
        return true
    }

    private func deliver(_ notice: NativeAttentionNotice, hostID: String?) async {
        guard let center else { return }
        await refreshPermission()
        if permission == "default" { await requestPermission() }
        guard permission == "granted" else { return }
        // A permission prompt can outlive the request, a read action, a host
        // switch or a settings change. Revalidate after every suspension.
        guard let host = hosts[hostID ?? "local"], let task = host.tasks[notice.taskID],
              Self.enabled("enabled", in: host.preferences), Self.enabled(notice.kind, in: host.preferences),
              Self.notice(task: task, requests: host.requests)?.key == notice.key,
              !isViewed(notice, hostID: hostID) else { return }
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.threadIdentifier = "\(hostID ?? "local"):\(notice.projectID):\(notice.taskID)"
        content.userInfo = ["workspace_id": notice.projectID, "thread_id": notice.taskID, "host_id": hostID ?? ""]
        let request = UNNotificationRequest(identifier: "\(content.threadIdentifier):\(notice.key)", content: content, trigger: nil)
        do { try await center.add(request); notificationError = nil }
        catch { notificationError = error.localizedDescription }
    }

    private func isViewed(_ notice: NativeAttentionNotice, hostID: String?) -> Bool {
        NSApp.isActive && NSApp.keyWindow != nil && desktopPresent
            && currentHost() == hostID && store?.selectedTaskID.map { NativeHostManager.split($0).id } == notice.taskID
            && ["project", "pins", "chats"].contains(store?.selectedSection ?? "")
    }

    private func samplePresence() {
        desktopPresent = Self.nativeDesktopPresence() ?? (Date().timeIntervalSince(lastInteraction) < 120)
        // The Mac daemon probes native input-idle state itself at push delivery.
        // A client heartbeat would conflate a selected remote host with this Mac.
    }

    static func nativeDesktopPresence() -> Bool? {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              let onConsole = session["kCGSSessionOnConsoleKey"] as? Bool else { return nil }
        guard onConsole else { return false }
        let seconds = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: UInt32.max)!)
        guard seconds.isFinite, seconds >= 0 else { return nil }
        return seconds < 120
    }

    private static func permissionName(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral: "granted"
        case .denied: "denied"
        default: "default"
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let taskID = info["thread_id"] as? String ?? ""
        let projectID = info["workspace_id"] as? String ?? ""
        let hostID = (info["host_id"] as? String)?.nonempty
        Task { @MainActor in
            defer { completionHandler() }
            guard !taskID.isEmpty, !projectID.isEmpty else { return }
            NSApp.activate(ignoringOtherApps: true)
            NSApp.windows.first { $0.canBecomeMain && $0.isVisible }?.makeKeyAndOrderFront(nil)
            if let route { await route(hostID, projectID, taskID) }
            else if hostID == nil, let store, store.tasks.contains(where: { $0.id == taskID && $0.projectID == projectID }) {
                await store.selectTask(taskID)
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .badge])
    }
}
