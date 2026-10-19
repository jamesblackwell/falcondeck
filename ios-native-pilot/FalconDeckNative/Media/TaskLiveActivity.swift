@preconcurrency import ActivityKit
import CryptoKit
import Foundation
import Observation

struct TaskActivityRecord: Equatable {
    let id: String
    let attributes: NativeTaskAttributes
    var state: NativeTaskAttributes.ContentState
    var ended = false
}

@MainActor protocol TaskActivityServing {
    var enabled: Bool { get }
    var activities: [TaskActivityRecord] { get }
    func start(_ attributes: NativeTaskAttributes, state: NativeTaskAttributes.ContentState) throws -> String
    func update(_ id: String, state: NativeTaskAttributes.ContentState) async
    func end(_ id: String, state: NativeTaskAttributes.ContentState?, dismissAt: Date?) async
}

@MainActor private struct SystemTaskActivities: TaskActivityServing {
    var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
    var activities: [TaskActivityRecord] {
        Activity<NativeTaskAttributes>.activities.filter { $0.activityState != .dismissed }
            .map { TaskActivityRecord(id: $0.id, attributes: $0.attributes, state: $0.content.state, ended: $0.activityState == .ended) }
    }
    func start(_ attributes: NativeTaskAttributes, state: NativeTaskAttributes.ContentState) throws -> String {
        try Activity.request(attributes: attributes, content: content(state), pushType: nil).id
    }
    func update(_ id: String, state: NativeTaskAttributes.ContentState) async {
        await Activity<NativeTaskAttributes>.activities.first { $0.id == id }?.update(content(state))
    }
    func end(_ id: String, state: NativeTaskAttributes.ContentState?, dismissAt: Date?) async {
        await Activity<NativeTaskAttributes>.activities.first { $0.id == id }?.end(state.map(content), dismissalPolicy: dismissAt.map(ActivityUIDismissalPolicy.after) ?? .immediate)
    }
    private func content(_ state: NativeTaskAttributes.ContentState) -> ActivityContent<NativeTaskAttributes.ContentState> {
        ActivityContent(state: state, staleDate: state.phase.terminal ? nil : state.updatedAt.addingTimeInterval(90))
    }
}

/// One explicitly followed task. Changes are serialized and coalesced; token
/// streaming does not drive ActivityKit or create a background polling loop.
@MainActor @Observable final class TaskLiveActivity {
    private(set) var record: TaskActivityRecord?
    @ObservationIgnored private let client: any TaskActivityServing
    @ObservationIgnored private var work: Task<Void, Never>?
    @ObservationIgnored private var revision = UUID()
    init(client: (any TaskActivityServing)? = nil) { self.client = client ?? SystemTaskActivities() }
    var enabled: Bool { client.enabled }
    func isTracking(_ id: String) -> Bool { record?.attributes.threadID == id }
    func reconcileDismissal() {
        guard let record, !client.activities.contains(where: { $0.id == record.id && !$0.ended }) else { return }
        self.record = nil; revision = UUID()
    }

    static func pairingKey(_ session: SavedSession) -> String {
        let identity = [session.relay.absoluteString, session.sessionID, session.deviceID]
        return SHA256.hash(data: (try? JSONEncoder().encode(identity)) ?? Data()).map { String(format: "%02x", $0) }.joined()
    }
    func restore(pairing: String?) {
        let activities = client.activities
        record = activities.filter { $0.attributes.pairing == pairing && !$0.state.phase.terminal && !$0.ended }.max { $0.state.updatedAt < $1.state.updatedAt }
        let orphans = activities.filter { $0.id != record?.id }
        enqueue { for orphan in orphans { await self.client.end(orphan.id, state: nil, dismissAt: nil) } }
    }
    func start(task: AgentTask, project: String, pairing: String, now: Date = .now) throws {
        guard enabled else { throw PilotError("Allow Live Activities for Falcon Native in iOS Settings.") }
        guard task.running || task.awaitingInput else { throw PilotError("Start following a task while it is working or needs your input.") }
        let attributes = NativeTaskAttributes(pairing: pairing, workspaceID: task.projectID, threadID: task.id)
        guard try JSONEncoder().encode(attributes).count <= 1400 else { throw PilotError("This task's identifiers are too long for a Live Activity.") }
        if record?.attributes == attributes { return }
        let state = Self.state(task: task, project: project, startedAt: now, now: now, connected: true)
        let old = record
        let id = try client.start(attributes, state: state)
        revision = UUID(); record = TaskActivityRecord(id: id, attributes: attributes, state: state)
        enqueue { if let old { await self.client.end(old.id, state: nil, dismissAt: nil) } }
    }
    func refresh(task: AgentTask?, project: String?, connected: Bool, authoritative: Bool, now: Date = .now) {
        guard var active = record else { return }
        if let task, task.archived { stop(); return }
        // A compact sync page can omit an unselected task. Absence is not a
        // deletion; keep its last known status until an authoritative row arrives.
        let task = task.flatMap { $0.projectID == active.attributes.workspaceID ? $0 : nil }
        let fresh = connected && authoritative && task != nil
        // Disk previews may render immediately, but cannot complete a restored
        // activity or overwrite its authoritative status after process death.
        var state = active.state
        if authoritative, let task {
            state = Self.state(task: task, project: project ?? state.project, startedAt: state.startedAt, now: now, connected: fresh)
        } else { state.connected = false }
        let changed = state.title != active.state.title || state.project != active.state.project || state.phase != active.state.phase || state.connected != active.state.connected
        guard changed || fresh && now.timeIntervalSince(active.state.updatedAt) >= 30 else { return }
        // Query ActivityKit only for a meaningful change, not each metadata
        // burst. A swipe-dismissal is never permission to recreate the card.
        reconcileDismissal()
        guard record != nil else { return }
        active.state = state; record = active
        let current = UUID(); revision = current
        if state.phase.terminal && authoritative {
            record = nil
            enqueue { await self.client.end(active.id, state: state, dismissAt: now.addingTimeInterval(600)) }
        } else {
            enqueue {
                guard self.revision == current, self.record?.id == active.id else { return }
                await self.client.update(active.id, state: state)
            }
        }
    }
    func stop() {
        let ids = Set(client.activities.map(\.id) + [record?.id].compactMap { $0 }); record = nil; revision = UUID()
        enqueue { for id in ids { await self.client.end(id, state: nil, dismissAt: nil) } }
    }
    func settle() async { await work?.value }
    private func enqueue(_ operation: @escaping @MainActor () async -> Void) {
        let previous = work
        work = Task { await previous?.value; await operation() }
    }
    private static func state(task: AgentTask, project: String, startedAt: Date, now: Date, connected: Bool) -> NativeTaskAttributes.ContentState {
        let phase: NativeTaskAttributes.Phase = task.awaitingInput ? .needsInput : task.running ? .working : task.status == "error" ? .failed : .completed
        return .init(title: bounded(task.title, characters: 160, bytes: 1600, fallback: "Task"), project: bounded(project, characters: 80, bytes: 400, fallback: "FalconDeck"), phase: phase, startedAt: startedAt, updatedAt: now, connected: connected)
    }
    private static func bounded(_ value: String, characters: Int, bytes: Int, fallback: String) -> String {
        var text = String(value.prefix(characters))
        // JSON escaping and extended grapheme clusters can exceed a byte budget
        // even when a string contains very few displayed characters.
        while !text.isEmpty, ((try? JSONEncoder().encode(text).count) ?? Int.max) > bytes { text.removeLast() }
        return text.isEmpty ? fallback : text
    }
}

@MainActor extension AppModel {
    func followOnLockScreen(_ task: AgentTask) throws {
        guard !demo, connected, hasLiveSnapshot, let session = try? sessionLoader() else {
            #if DEBUG
            if demo, ProcessInfo.processInfo.arguments.contains("--task-activity-preview") {
                try taskActivity.start(task: task, project: "Local preview", pairing: String(repeating: "0", count: 64))
                if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--task-activity-phase=") }) {
                    let phase = String(argument.dropFirst("--task-activity-phase=".count)), scope = sessionScope
                    Task {
                        try? await Task.sleep(for: .seconds(8))
                        guard self.demo, scope == self.sessionScope, self.taskActivity.isTracking(task.id) else { return }
                        if phase == "offline" { self.connected = false; self.synchronizeTaskActivity() }
                        else {
                            let status = ["input": "waiting_for_input", "complete": "idle", "error": "error"][phase] ?? "running"
                            self.upsertTask(task.raw.setting("status", .string(status)))
                        }
                    }
                }
                return
            }
            #endif
            throw PilotError("Connect to your computer to follow this task.")
        }
        try taskActivity.start(task: task, project: projects.first { $0.id == task.projectID }?.name ?? "FalconDeck", pairing: TaskLiveActivity.pairingKey(session))
    }
    func synchronizeTaskActivity() {
        guard let active = taskActivity.record else { return }
        var task = task(active.attributes.threadID)
        if let current = task, requests.contains(where: { $0["thread_id"].string == current.id }) {
            task = AgentTask(current.raw.setting("status", .string("waiting_for_input")))
        }
        taskActivity.refresh(task: task, project: projects.first { $0.id == active.attributes.workspaceID }?.name, connected: connected,
                             authoritative: hasLiveSnapshot && !previewTaskIDs.contains(active.attributes.threadID))
    }
    func openTaskActivity(_ url: URL) async {
        guard let target = NativeTaskAttributes(url: url), let session = try? sessionLoader(),
              target.pairing == TaskLiveActivity.pairingKey(session),
              let destination = NotificationDestination(userInfo: ["sessionId": session.sessionID, "workspaceId": target.workspaceID, "threadId": target.threadID]) else { return }
        pendingNotification = destination
        if task(target.threadID)?.projectID == target.workspaceID { selection = .task(target.threadID) }
        await openPendingNotification()
    }
}
