import Foundation
import Observation

/// The notification centre for the paired computer. The daemon owns the records,
/// so a refresh always wins over what was loaded before, except for reads
/// the daemon has not heard about yet. Reports hosted on the relay fill in while
/// the computer is out of reach, and step aside as soon as it is back.
@MainActor @Observable
final class NotificationCentreStore {
    struct Page: Equatable {
        var items: [NotificationRecord] = []
        var nextBeforeSeq: Int?
        var loaded = false
    }

    nonisolated static let pageSize = 50
    static let maxPageSize = 200
    /// How many hosted reports are opened for the offline list.
    static let reportLimit = 50

    private(set) var pages: [NotificationFilter: Page] = [:]
    private(set) var counts = NotificationCounts()
    private(set) var filter = NotificationFilter.all
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var loadMoreFailed = false
    private(set) var loadingReports = false
    private(set) var refreshError: String?
    /// A mark-read the computer refused; the rows were put back.
    private(set) var actionError: String?
    /// The computer does not know the notification RPCs (an older daemon).
    private(set) var unsupported = false
    /// Reads that have not reached the daemon yet; survives a relaunch.
    private(set) var offlineReads: Set<String> = []
    /// Hosted reports as rows, newest first. Shown only while out of reach.
    private(set) var reportRecords: [NotificationRecord] = []
    private(set) var replies: [String: String] = [:]
    /// A notification tap asking the list to open this.
    var openRequest: NotificationDetailTarget?

    @ObservationIgnored private let readQueue: NotificationOfflineReads
    @ObservationIgnored private let reportClient: NotificationReportClient
    @ObservationIgnored private let replyRoot: URL?
    /// How long a dropped connection must last before the relay is asked for
    /// reports. A routine reconnect should cost no requests.
    @ObservationIgnored private let offlineSettle: Duration
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var mutationRevision = 0
    @ObservationIgnored private var inFlightReads: Set<String> = []
    @ObservationIgnored private var inFlightUpToSeq: Int?
    @ObservationIgnored private var readsOverlapped = false
    @ObservationIgnored private var replaying = false
    @ObservationIgnored private var readsRestored = false
    @ObservationIgnored private var readSessionID: String?
    @ObservationIgnored private var reports: [String: NotificationReport] = [:]
    /// Reports that failed to open with this data key; a new key clears them.
    @ObservationIgnored private var unreadableReports: Set<String> = []
    @ObservationIgnored private var reportKey: Data?
    @ObservationIgnored private var reportsCheckedAt: Date?
    @ObservationIgnored private var vaultCache: NotificationReplyVault?
    @ObservationIgnored private var repliesRestored = false
    @ObservationIgnored private var replySaves: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var demoRecords: [NotificationRecord]?

    init(defaults: UserDefaults = .standard, reportClient: NotificationReportClient = NotificationReportClient(), replyRoot: URL? = nil, offlineSettle: Duration = .seconds(3)) {
        readQueue = NotificationOfflineReads(defaults: defaults)
        self.reportClient = reportClient; self.replyRoot = replyRoot; self.offlineSettle = offlineSettle
    }

    // MARK: What is shown

    /// The row and screen vanish when the computer is too old to have a centre.
    var entryVisible: Bool { !unsupported }
    var hasMore: Bool { pages[filter]?.nextBeforeSeq != nil }
    var loaded: Bool { pages[filter]?.loaded ?? false }

    func isOffline(_ model: AppModel) -> Bool {
        model.demo ? NotificationDemo.offline : !model.connected
    }

    /// The current filter's rows. While offline these are what was last loaded
    /// plus any hosted report the list has no row for yet.
    func visibleRecords(offline: Bool) -> [NotificationRecord] {
        let base = pages[filter]?.items ?? (offline ? (pages[.all]?.items ?? []).filter { $0.matches(filter) } : [])
        guard offline else { return base }
        let known = Set(pages.values.flatMap { $0.items.map(\.id) })
        let hosted = reportRecords.filter { !known.contains($0.id) && $0.matches(filter) }.map(overlaid)
        return hosted.isEmpty ? base : (base + hosted).sorted { $0.createdAt > $1.createdAt }
    }

    /// Unread across the store, plus hosted reports the count cannot know about.
    func unreadCount(offline: Bool) -> Int {
        guard offline else { return counts.unread }
        let known = Set(pages.values.flatMap { $0.items.map(\.id) })
        return counts.unread + reportRecords.filter { !known.contains($0.id) && !offlineReads.contains($0.id) }.count
    }

    func record(_ id: String) -> NotificationRecord? {
        for page in pages.values { if let record = page.items.first(where: { $0.id == id }) { return record } }
        return reportRecords.first { $0.id == id }.map(overlaid)
    }

    private func overlaid(_ record: NotificationRecord) -> NotificationRecord {
        guard !record.isRead, readPending(record) else { return record }
        return record.markedRead(at: .now)
    }
    private func readPending(_ record: NotificationRecord) -> Bool {
        offlineReads.contains(record.id) || inFlightReads.contains(record.id) || inFlightUpToSeq.map { record.seq <= $0 && record.seq > 0 } ?? false
    }

    // MARK: Lifecycle

    /// Called when a connection starts. A reconnect keeps what is on screen,
    /// including reads waiting to be replayed; a new pairing or the demo starts
    /// clean, and forgetting a computer also removes what was kept for it.
    func reset(clearData: Bool, forgotten: Bool) {
        refreshTask?.cancel(); refreshTask = nil
        refreshAgain = false; mutationRevision += 1; generation += 1; loading = false; loadingMore = false
        guard clearData else { return }
        for task in replySaves.values { task.cancel() }
        replySaves = [:]
        pages = [:]; counts = NotificationCounts(); filter = .all; refreshError = nil; actionError = nil; unsupported = false; loadMoreFailed = false
        offlineReads = []; inFlightReads = []; inFlightUpToSeq = nil; readsOverlapped = false; readsRestored = false; readSessionID = nil
        reports = [:]; reportRecords = []; unreadableReports = []; reportKey = nil; reportsCheckedAt = nil
        replies = [:]; repliesRestored = false; vaultCache = nil; demoRecords = nil; openRequest = nil
        Task { [reportClient] in await reportClient.forgetCapabilities() }
        if forgotten { readQueue.purge(); NotificationReplyVault.purge(root: replyRoot) }
    }

    /// The computer is reachable again: its copy of events comes first.
    func computerReached(model: AppModel) {
        reportsCheckedAt = nil
        let gen = generation
        Task {
            await self.replayOfflineReads(model: model)
            guard gen == self.generation else { return }
            await self.refresh(model: model)
        }
    }

    func setFilter(_ filter: NotificationFilter) {
        guard filter != self.filter else { return }
        self.filter = filter; loadMoreFailed = false
    }

    // MARK: Fetching

    func refresh(model: AppModel, immediate: Bool = false) async {
        if model.demo { seedDemo(); return }
        guard model.connected else { await refreshReports(model: model, immediate: immediate); return }
        guard !loading else { refreshAgain = true; return }
        let gen = generation, current = model.connectionID, started = mutationRevision, filter = self.filter
        loading = true; refreshError = nil
        defer {
            if gen == generation {
                loading = false
                if refreshAgain { refreshAgain = false; scheduleRefresh(model: model) }
            }
        }
        await restoreOfflineReads(model: model)
        do {
            // Re-read everything on screen from the head, so nothing is skipped
            // and no older row keeps a state another device has since changed.
            let existing = pages[filter] ?? Page()
            let wanted = max(Self.pageSize, existing.loaded ? existing.items.count : 0)
            var items: [NotificationRecord] = [], seen: Set<String> = [], cursor: Int?, first: NotificationCounts?
            repeat {
                let limit = min(Self.maxPageSize, wanted - items.count)
                let response = NotificationListResponse(try await model.relay.call("notifications.list", params: Self.listParameters(filter: filter, limit: limit, beforeSeq: cursor)))
                guard current == model.connectionID, gen == generation else { return }
                // A response captured before a read must not make that record unread again.
                guard started == mutationRevision else { refreshAgain = true; return }
                let fresh = response.items.filter { seen.insert($0.id).inserted }
                items += fresh
                cursor = response.nextBeforeSeq
                // The first page's `latest_seq` matches the top of the list; a later
                // one could cover a record James was never shown, and mark-all would take it.
                first = first ?? response.counts
                if fresh.isEmpty { break }
            } while items.count < wanted && cursor != nil
            pages[filter] = Page(items: items.map(overlaid), nextBeforeSeq: cursor, loaded: true)
            adopt(first ?? NotificationCounts(), listed: items)
            unsupported = false
            model.schedulePreviewSave()
            if filter != self.filter { refreshAgain = true }
        } catch {
            guard current == model.connectionID, gen == generation else { return }
            if model.connected, Self.looksUnsupported(error) { unsupported = true; pages = [:]; counts = NotificationCounts() }
            else if !(pages[filter]?.loaded ?? false) { refreshError = "Couldn't load notifications. Pull to refresh." }
        }
    }

    func scheduleRefresh(model: AppModel) {
        guard refreshTask == nil else { return }
        let gen = generation
        refreshTask = Task {
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard gen == self.generation else { return }
            self.refreshTask = nil
            await self.refresh(model: model)
        }
    }

    /// The `control-state-changed` event names the domains that moved.
    func controlStateChanged(_ event: JSON, model: AppModel) {
        guard event["change"]["domains"].array.contains(.string("notifications")) else { return }
        scheduleRefresh(model: model)
    }

    func loadMore(model: AppModel) async {
        let filter = self.filter
        guard !model.demo, model.connected, !loadingMore, let cursor = pages[filter]?.nextBeforeSeq else { return }
        let gen = generation, current = model.connectionID, started = mutationRevision
        loadingMore = true; loadMoreFailed = false
        defer { if gen == generation { loadingMore = false } }
        do {
            let response = NotificationListResponse(try await model.relay.call("notifications.list", params: Self.listParameters(filter: filter, limit: Self.pageSize, beforeSeq: cursor)))
            guard current == model.connectionID, gen == generation else { return }
            var page = pages[filter] ?? Page()
            // Only the page this cursor came from may grow; a refresh may have replaced it.
            guard page.nextBeforeSeq == cursor else { return }
            let known = Set(page.items.map(\.id))
            page.items += response.items.filter { !known.contains($0.id) }.map(overlaid)
            page.nextBeforeSeq = response.nextBeforeSeq
            pages[filter] = page
            if started == mutationRevision { adopt(response.counts, listed: response.items, head: false) } else { scheduleRefresh(model: model) }
        } catch {
            guard current == model.connectionID, gen == generation else { return }
            loadMoreFailed = true
        }
    }

    /// The daemon's counts, less reads it has not seen yet.
    private func adopt(_ incoming: NotificationCounts, listed: [NotificationRecord], head: Bool = true) {
        var adopted = incoming
        adopted.unread = max(0, incoming.unread - listed.filter { !$0.isRead && readPending($0) }.count)
        if !head { adopted.latestSeq = counts.latestSeq }
        counts = adopted
    }

    /// Only a head read moves `latest_seq`. Anything else can report a record
    /// James has not been shown, and mark-all would take it.
    private func adoptKeepingHead(_ incoming: NotificationCounts) {
        var adopted = incoming
        adopted.latestSeq = counts.latestSeq
        counts = adopted
    }

    static func listParameters(filter: NotificationFilter, limit: Int, beforeSeq: Int?) -> JSON {
        var fields: [String: JSON] = ["filter": .string(filter.rawValue), "limit": .number(Double(limit))]
        if let beforeSeq { fields["before_seq"] = .number(Double(beforeSeq)) }
        return .object(fields)
    }
    /// An older daemon answers an unknown RPC with an error naming the method.
    /// The relay refuses a method no daemon registered without reaching one.
    static func looksUnsupported(_ error: Error) -> Bool {
        ReviewStore.looksUnsupported(error) || error.localizedDescription.lowercased().contains("method_unavailable")
    }

    // MARK: Read state

    /// Marks one record read now. If the computer is out of reach the read is
    /// kept and replayed. A refusal from a reachable computer is put back.
    func markRead(_ id: String, model: AppModel) async {
        guard !offlineReads.contains(id), !inFlightReads.contains(id) else { return }
        let listed = pages.values.lazy.compactMap { $0.items.first { $0.id == id } }.first
        if listed?.isRead == true { return }
        mutationRevision += 1; actionError = nil
        applyRead([id])
        if listed != nil { counts.unread = max(0, counts.unread - 1) }
        guard !model.demo else { return }
        guard model.connected else { await keepOffline(id, model: model); return }
        let current = model.connectionID, scope = model.sessionScope
        inFlightReads.insert(id)
        do {
            let response = try await model.relay.call("notifications.mark_read", params: .object(["ids": .array([.string(id)])]))
            inFlightReads.remove(id)
            guard current == model.connectionID else { return }
            mutationRevision += 1
            settleRead(NotificationCounts(response), model: model)
        } catch {
            inFlightReads.remove(id)
            guard scope == model.sessionScope else { return }
            if !model.connected || current != model.connectionID { await keepOffline(id, model: model); return }
            mutationRevision += 1
            applyUnread([id])
            if listed != nil { counts.unread += 1 }
            actionError = "Couldn't mark that as read. Try again."
        }
    }

    /// Everything up to the newest `seq` James was showing, so a record that
    /// arrived since stays unread. The whole store, whatever the filter.
    func markAllRead(model: AppModel) async {
        let upTo = counts.latestSeq, previous = counts.unread
        guard previous > 0, model.demo || model.connected, inFlightUpToSeq == nil else { return }
        let touched = Set(pages.values.flatMap(\.items).filter { !$0.isRead && $0.seq <= upTo }.map(\.id))
        mutationRevision += 1; actionError = nil
        applyRead(touched)
        counts.unread = 0
        guard !model.demo else { return }
        let current = model.connectionID, scope = model.sessionScope
        inFlightUpToSeq = upTo
        do {
            let response = try await model.relay.call("notifications.mark_read", params: .object(["up_to_seq": .number(Double(upTo))]))
            inFlightUpToSeq = nil
            guard current == model.connectionID else { return }
            mutationRevision += 1
            settleRead(NotificationCounts(response), model: model)
        } catch {
            inFlightUpToSeq = nil
            guard scope == model.sessionScope else { return }
            mutationRevision += 1
            applyUnread(touched)
            counts.unread = previous
            actionError = "Couldn't mark everything as read. Try again."
        }
    }

    /// Answers can cross, so the last to arrive may hold the oldest counts. Reads
    /// that overlapped are settled by a fresh read of the list.
    private func settleRead(_ incoming: NotificationCounts, model: AppModel) {
        guard inFlightReads.isEmpty, inFlightUpToSeq == nil else { readsOverlapped = true; return }
        adoptKeepingHead(incoming)
        if readsOverlapped { readsOverlapped = false; scheduleRefresh(model: model) }
    }

    private func applyRead(_ ids: Set<String>) {
        let now = Date.now
        updateRecords { $0.isRead || !ids.contains($0.id) ? $0 : $0.markedRead(at: now) }
    }
    private func applyUnread(_ ids: Set<String>) {
        updateRecords { ids.contains($0.id) ? $0.markedUnread() : $0 }
    }
    private func updateRecords(_ change: (NotificationRecord) -> NotificationRecord) {
        pages = pages.mapValues { page in
            var page = page
            page.items = page.items.map(change)
            return page
        }
        demoRecords = demoRecords?.map(change)
    }

    // MARK: Reads kept for later

    private func keepOffline(_ id: String, model: AppModel) async {
        offlineReads.insert(id)
        await restoreOfflineReads(model: model)
        persistOfflineReads()
    }
    private func persistOfflineReads() {
        if let readSessionID { readQueue.save(offlineReads, sessionID: readSessionID) }
    }
    private func restoreOfflineReads(model: AppModel) async {
        guard !readsRestored, !model.demo else { return }
        let scope = model.sessionScope
        guard let session = await session(model), scope == model.sessionScope, !readsRestored else { return }
        readsRestored = true; readSessionID = session.sessionID
        readQueue.retain(sessionID: session.sessionID)
        offlineReads.formUnion(readQueue.load(sessionID: session.sessionID))
        updateRecords(overlaid)
    }

    /// Sends what was read while the computer was away. A failure keeps them
    /// for the next reconnect; the daemon ignores ids it no longer holds.
    func replayOfflineReads(model: AppModel) async {
        await restoreOfflineReads(model: model)
        guard !model.demo, model.connected, !replaying, !offlineReads.isEmpty else { return }
        replaying = true; defer { replaying = false }
        let ids = offlineReads, current = model.connectionID
        guard let response = try? await model.relay.call("notifications.mark_read", params: .object(["ids": .array(ids.sorted().map(JSON.string))])),
              current == model.connectionID else { return }
        offlineReads.subtract(ids)
        persistOfflineReads()
        mutationRevision += 1
        adoptKeepingHead(NotificationCounts(response))
    }

    // MARK: Reports on the relay

    private func session(_ model: AppModel) async -> SavedSession? {
        let loader = model.sessionLoader
        return await Task.detached(priority: .userInitiated) { try? loader() }.value
    }

    /// The offline half of a refresh. `immediate` is James pulling to refresh;
    /// otherwise this waits out a passing disconnect and stays infrequent.
    private func refreshReports(model: AppModel, immediate: Bool) async {
        guard model.hasSession, model.networkAvailable else { return }
        if !immediate {
            do { try await Task.sleep(for: offlineSettle) } catch { return }
            guard !model.connected else { return }
            if let reportsCheckedAt, Date.now.timeIntervalSince(reportsCheckedAt) < 60 { return }
        }
        guard !loadingReports else { return }
        loadingReports = true; defer { loadingReports = false }
        await restoreOfflineReads(model: model)
        let scope = model.sessionScope
        guard let session = await session(model), let key = session.dataKey, scope == model.sessionScope,
              await reportClient.capability(session) != nil else { return }
        guard let listed = try? await reportClient.list(session: session), scope == model.sessionScope else { return }
        if reportKey != key { reportKey = key; reports = [:]; unreadableReports = [] }
        // After a key rotation a report is unreadable only until the daemon has
        // sealed it again, so pulling to refresh always tries.
        if immediate { unreadableReports = [] }
        reportsCheckedAt = .now
        let live = listed.filter { ($0.expiresAt ?? .distantFuture) > .now }.prefix(Self.reportLimit).map(\.reportID)
        let missing = live.filter { reports[$0] == nil && !unreadableReports.contains($0) }
        let opened = await reportClient.fetch(missing, session: session)
        guard scope == model.sessionScope else { return }
        for report in opened.reports { reports[report.reportID] = report }
        unreadableReports.formUnion(opened.failed)
        // What the relay no longer lists has expired.
        let keep = Set(live)
        reports = reports.filter { keep.contains($0.key) }
        publishReports()
    }

    private func publishReports() {
        reportRecords = reports.values.map(\.record).sorted { $0.createdAt > $1.createdAt }
    }

    /// One hosted report, from memory or the relay. A relay without reports
    /// gets no call at all. Any failure is nil: the caller falls back.
    private func report(_ id: String, for notificationID: String?, model: AppModel) async -> NotificationReport? {
        let scope = model.sessionScope
        guard let session = await session(model), scope == model.sessionScope, session.dataKey != nil else { return nil }
        if reportKey != session.dataKey { reportKey = session.dataKey; reports = [:]; unreadableReports = [] }
        var report = reports[id]
        if report == nil {
            guard await reportClient.capability(session) != nil else { return nil }
            report = try? await reportClient.fetch(id, session: session)
        }
        guard let report, scope == model.sessionScope, notificationID == nil || notificationID == report.notificationID else { return nil }
        if reports[id] == nil { reports[id] = report; publishReports() }
        return report
    }

    /// Everything the detail screen needs. The computer's copy comes first; the
    /// relay's copy is the fallback, and "on your computer" is the honest end.
    func detail(for target: NotificationDetailTarget, model: AppModel) async -> NotificationDetail {
        let known = target.notificationID.flatMap(record)
        if model.demo { return demoDetail(target, known: known) }
        if model.connected, let id = target.notificationID,
           let response = try? await model.relay.call("notification.get", params: .object(["id": .string(id)])), let full = NotificationRecord(response) {
            return NotificationDetail(record: overlaid(full), body: full.body)
        }
        if let reportID = target.reportID ?? known?.report?.reportID,
           let report = await report(reportID, for: target.notificationID, model: model) {
            if target.notificationID == nil { await markRead(report.notificationID, model: model) }
            return NotificationDetail(record: known ?? overlaid(report.record), body: report.body.nonempty, fromRelay: true)
        }
        if let known, !known.hasBody { return NotificationDetail(record: known) }
        return NotificationDetail(record: known, onComputer: true)
    }

    // MARK: Replies

    func reply(_ id: String) -> String { replies[id] ?? "" }

    /// A reply lives in memory (so leaving the screen keeps it) and, when
    /// paired, in an encrypted device file (so relaunching does).
    func editReply(_ id: String, text: String, model: AppModel) {
        replies[id] = text.isEmpty ? nil : text
        guard !model.demo else { return }
        replySaves[id]?.cancel()
        let gen = generation
        replySaves[id] = Task {
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard gen == self.generation, let vault = await self.vault(model: model) else { return }
            try? await vault.save(self.reply(id), notificationID: id)
        }
    }

    /// Writes one reply now. Dictation waits on this before its audio is deleted.
    func persistReply(_ id: String, model: AppModel) async -> Bool {
        guard !model.demo else { return true }
        replySaves[id]?.cancel(); replySaves[id] = nil
        guard let vault = await vault(model: model) else { return false }
        do { try await vault.save(reply(id), notificationID: id); return true } catch { return false }
    }

    func restoreReplies(model: AppModel) async {
        guard !repliesRestored, !model.demo else { return }
        repliesRestored = true
        let gen = generation
        guard let vault = await vault(model: model), gen == generation else { repliesRestored = false; return }
        let saved = await vault.load()
        guard gen == generation else { return }
        for (id, text) in saved where replies[id] == nil { replies[id] = text }
    }

    private func vault(model: AppModel) async -> NotificationReplyVault? {
        if let vaultCache { return vaultCache }
        let scope = model.sessionScope
        // A re-pair during the load must not bring back the old computer's vault.
        guard let session = await session(model), scope == model.sessionScope,
              let vault = NotificationReplyVault(session: session, root: replyRoot) else { return nil }
        vaultCache = vault
        return vault
    }

    // MARK: Offline preview

    /// A disposable copy of the newest rows, so a cold launch with the Mac asleep
    /// still shows what was last loaded. Never a source of truth.
    var previewSnapshot: CachedNotifications? {
        guard let page = pages[.all], page.loaded else { return nil }
        return CachedNotifications(rows: page.items.prefix(Self.pageSize).map(\.raw).filter { $0 != .null }, unread: counts.unread, needsYou: counts.needsYou)
    }
    func restorePreview(_ cached: CachedNotifications?) {
        guard let cached, pages[.all] == nil else { return }
        pages[.all] = Page(items: cached.rows.compactMap(NotificationRecord.init).map(overlaid))
        counts = NotificationCounts(unread: cached.unread, needsYou: cached.needsYou)
    }

    // MARK: Demo

    private func seedDemo() {
        let records: [NotificationRecord]
        if let demoRecords { records = demoRecords } else { records = NotificationDemo.records(now: .now); demoRecords = records }
        for filter in NotificationFilter.allCases { pages[filter] = Page(items: records.filter { $0.matches(filter) }, loaded: true) }
        counts = NotificationCounts(unread: records.filter { !$0.isRead }.count, needsYou: records.filter(\.isWaiting).count, latestSeq: records.map(\.seq).max() ?? 0)
        if NotificationDemo.offline {
            reports = NotificationDemo.reports(now: .now)
            publishReports()
        }
    }

    private func demoDetail(_ target: NotificationDetailTarget, known: NotificationRecord?) -> NotificationDetail {
        guard let known else { return NotificationDetail(onComputer: true) }
        guard NotificationDemo.offline else { return NotificationDetail(record: known, body: known.body) }
        if let body = known.body, known.report != nil { return NotificationDetail(record: known, body: body, fromRelay: true) }
        return known.hasBody ? NotificationDetail(record: known, onComputer: true) : NotificationDetail(record: known)
    }
}

/// The small offline copy kept in the encrypted session preview.
struct CachedNotifications: Codable, Sendable, Equatable {
    var rows: [JSON]
    var unread: Int
    var needsYou: Int
}
