import CryptoKit
import Foundation

/// What `sync.index` should ship ready to render: the newest rows of the lists
/// on screen, so a refresh is one request instead of one per list. The daemon
/// adds pins, bots and anything that needs attention. Older daemons ignore the
/// fields and answer with the original index; the sidebar then pages as before.
struct SyncIndexScope: Sendable, Equatable {
    static let rowsPerList = 5
    static let recentChats = 20
    var workspaceIDs: [String] = []

    func params(selected: String?) -> JSON {
        .object([
            "selected_thread_id": selected.map(JSON.string) ?? .null,
            "recent_per_workspace": .number(Double(Self.rowsPerList)),
            "recent_workspace_ids": .array(workspaceIDs.prefix(16).map(JSON.string)),
            "recent_chats": .number(Double(Self.recentChats)),
        ])
    }
}

/// Stream-class events (text, items, tool calls) are only delivered for threads
/// the phone subscribed to. The relay sees these opaque tags, never thread ids.
enum EventScope {
    static let maxTags = 64

    /// First 12 bytes of HMAC-SHA256(session data key, "falcondeck-scope-v1\0" + thread id),
    /// base64url without padding. The daemon computes the identical tag.
    static func tag(thread id: String, key: Data) -> String {
        let code = HMAC<SHA256>.authenticationCode(for: Data("falcondeck-scope-v1\0".utf8) + Data(id.utf8), using: SymmetricKey(data: key))
        return Data(code.prefix(12)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func tags(for threads: Set<String>, key: Data) -> [String] {
        threads.sorted().prefix(maxTags).map { tag(thread: $0, key: key) }
    }
}

/// Bytes and counts received per kind since the connection opened. Cheap
/// dictionary arithmetic on the relay actor; shown under Developer, and written
/// to `Documents/sync-meter.json` by `--sync-meter` launches for measurement.
struct SyncMeter: Sendable {
    struct Entry: Codable, Sendable, Equatable { var count = 0; var bytes = 0 }
    struct Report: Codable, Sendable {
        var seconds: Double
        var entries: [String: Entry]
        var totalBytes: Int { entries.filter { $0.key.hasPrefix("wire.") }.values.reduce(0) { $0 + $1.bytes } }
    }
    private(set) var startedAt = Date.now
    private(set) var entries: [String: Entry] = [:]

    mutating func record(_ kind: String, bytes: Int = 0) {
        entries[kind, default: Entry()].count += 1
        entries[kind, default: Entry()].bytes += bytes
    }
    mutating func reset() { self = SyncMeter() }
    func report(now: Date = .now) -> Report { Report(seconds: now.timeIntervalSince(startedAt), entries: entries) }

    static var dumpEnabled: Bool { ProcessInfo.processInfo.arguments.contains("--sync-meter") }
    func dump(to url: URL) {
        guard let data = try? JSONEncoder().encode(report()) else { return }
        try? data.write(to: url, options: .atomic)
    }
    static var dumpURL: URL? { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.appending(path: "sync-meter.json") }
}

/// Phone-side bookkeeping for scoped events and background pauses.
struct SyncScopeState {
    /// The relay accepts `scope` messages on this connection.
    var scopedEvents = false
    /// Hint for the next index: the project lists the sidebar has open.
    var index = SyncIndexScope()
    var sortedBy = ""

    var backgroundedAt: Date?
    var pause: Task<Void, Never>?
    /// The socket was closed on purpose; foregrounding must reconnect.
    var paused = false
    /// `--sync-legacy` restores the previous sync behaviour (a refresh per
    /// foreground, one page request per list, every thread's live stream, an
    /// open socket in the background) for before/after measurements.
    static var legacy: Bool { ProcessInfo.processInfo.arguments.contains("--sync-legacy") }
    /// Backgrounded for less than this long keeps its live connection and
    /// skips the resume refresh: nothing could have been missed.
    static let quickReturn: TimeInterval = 20
    /// How long the app lingers in the background before closing its socket.
    var pauseGrace: Duration = .seconds(10)
}

@MainActor extension AppModel {
    /// Threads whose live stream this phone wants: the ones just opened, plus
    /// any with a send or history read in flight. Everything else gets only
    /// summary updates, which are enough for lists, unread and notifications.
    var eventInterest: Set<String> {
        var ids = Set(recentlyOpen)
        for (id, chat) in chats where chat.loading || chat.submission != nil || chat.outgoingMessage != nil { ids.insert(id) }
        return ids
    }

    func noteOpened(_ id: String) {
        recentlyOpen.removeAll { $0 == id }
        recentlyOpen.insert(id, at: 0)
        extensions.ensureThreads([id], model: self)
        if recentlyOpen.count > 3 { recentlyOpen.removeLast(recentlyOpen.count - 3) }
        updateEventInterest()
    }

    func updateEventInterest() {
        guard !demo else { return }
        let interest = eventInterest
        guard interest != pushedInterest else { return }
        pushedInterest = interest
        Task { await relay.setInterest(interest) }
    }

    /// The sidebar's open project lists, so the next index ships their rows.
    func noteExpanded(_ projectIDs: Set<String>) {
        let sort = UserDefaults.standard.string(forKey: "native.sidebar.sort") ?? "last_updated"
        let ids = projectIDs.sorted()
        guard ids != syncScope.index.workspaceIDs || sort != syncScope.sortedBy else { return }
        syncScope.index.workspaceIDs = ids; syncScope.sortedBy = sort
        // Other sort orders are not a prefix of the recency order the daemon
        // ships, so they page as before.
        let scope: SyncIndexScope? = sort == "last_updated" ? syncScope.index : nil
        Task { await relay.setIndexScope(scope) }
    }

    /// Before the sidebar reports anything, expect the first project and the
    /// open task's project, which is what it expands by default.
    func seedIndexScope() {
        guard syncScope.index.workspaceIDs.isEmpty else { return }
        var ids = Set<String>()
        if case .task(let id) = selection, let task = task(id) { ids.insert(task.projectID) }
        if let first = sortedProjects.first(where: { $0.raw["kind"].string != "casual" && !botWorkspaceIDs.contains($0.id) }) { ids.insert(first.id) }
        if !ids.isEmpty { noteExpanded(ids) }
    }

    /// Close the socket once the app has been in the background for the grace
    /// period with nothing in flight. Foregrounding reconnects.
    func scheduleBackgroundPause() {
        syncScope.pause?.cancel()
        guard hasSession, !demo, connected, !SyncScopeState.legacy else { syncScope.pause = nil; return }
        let lease = backgroundExecution.begin("Close idle connection")
        syncScope.pause = Task {
            defer { lease.finish() }
            do { try await Task.sleep(for: self.syncScope.pauseGrace) } catch { return }
            guard !self.foreground, self.connected, !lease.expired else { return }
            // Audio, dictation and a followed Lock Screen task need live events.
            guard !self.voice.starting, !self.voice.recording, !self.voice.transcribing, self.readAloud.messageID == nil, self.taskActivity.record == nil else { return }
            guard await self.relay.pauseIfIdle(), !self.foreground else { return }
            self.syncScope.paused = true; self.connected = false; self.status = "Paused in background"
            self.pushedInterest = []
        }
    }
}

/// The sidebar lists the newest rows of a project or Chats, plus any older row
/// that still needs the user, so "Show more" is never needed to find them.
enum SidebarRows {
    static func visible(_ ordered: [AgentTask], limit: Int) -> [AgentTask] {
        guard ordered.count > limit else { return ordered }
        return Array(ordered.prefix(limit)) + ordered.dropFirst(limit).filter(\.demandsAttention)
    }
}

extension AgentTask {
    /// Running, waiting on the user, failed or unread: worth listing at any age.
    var demandsAttention: Bool { working || needsAttention || unread }
}
