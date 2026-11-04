import Foundation
import Observation

/// The bell and list for the selected host. The daemon owns every record, so
/// nothing here outlives a refetch except the ids already announced as banners.
@MainActor @Observable final class NotificationCentreStore {
    typealias Transport = @MainActor (_ path: [String], _ method: String, _ query: [URLQueryItem], _ body: JSON?, _ hostID: String?) async throws -> JSON
    typealias NoticeHandler = @MainActor (_ record: NotificationRecord, _ hostID: String?) -> Void

    static let pageSize = 50
    static let maximumPage = 200
    /// A reconnect can reveal a backlog. The list holds the rest.
    static let maximumBannersPerFetch = 3

    private(set) var records: [NotificationRecord] = []
    private(set) var counts = NotificationCounts()
    private(set) var filter = NotificationFilter.all
    private(set) var nextBeforeSeq: Int?
    private(set) var hasLoaded = false
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var loadError: String?
    private(set) var loadMoreError: String?
    /// A failed action or a dead link. Shown in the list, not as a load failure.
    private(set) var message: String?
    private(set) var hostID: String?
    /// The selected daemon predates the centre, so there is no bell at all.
    private(set) var unsupported = false
    /// Bumped when a host reports the `reviews` domain moved.
    private(set) var reviewRevision = 0
    var isPresented = false

    @ObservationIgnored var transport: Transport?
    @ObservationIgnored var onNewNotice: NoticeHandler?
    @ObservationIgnored private let debounce: Duration
    /// Identifies a list request: a new host or filter orphans older responses.
    @ObservationIgnored private var listGeneration = 0
    /// Identifies a host: its mutations stop touching state once it is left.
    @ObservationIgnored private var hostGeneration = 0
    /// Bumped at both ends of a mutation, so a response that began before or
    /// during one cannot undo it.
    @ObservationIgnored private var mutationRevision = 0
    @ObservationIgnored private var mutationsInFlight = 0
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var loadMoreAgain = false
    @ObservationIgnored private var scheduled: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var unsupportedHosts: Set<String> = []
    private struct NoticeWatch {
        /// `latest_seq` at first load. Nothing at or below it is ever new.
        let baseline: Int
        var seen: Set<String> = []
    }
    @ObservationIgnored private var watches: [String: NoticeWatch] = [:]

    init(transport: Transport? = nil, debounce: Duration = .milliseconds(250)) {
        self.transport = transport
        self.debounce = debounce
    }

    private static func key(_ host: String?) -> String { host ?? "local" }
    var canMarkAllRead: Bool { counts.unread > 0 && counts.latestSeq > 0 }

    // MARK: Following the app

    func follow(hostID host: String?) {
        guard host != hostID else { return }
        hostID = host
        hostGeneration += 1
        listGeneration += 1
        mutationsInFlight = 0
        refreshAgain = false
        loadMoreAgain = false
        records = []
        counts = NotificationCounts()
        nextBeforeSeq = nil
        hasLoaded = false
        isLoading = false
        isLoadingMore = false
        loadError = nil
        loadMoreError = nil
        message = nil
        unsupported = unsupportedHosts.contains(Self.key(host))
        schedule(host)
    }

    /// A host's snapshot arrived, so it may be new or newly upgraded.
    func connected(hostID host: String?) { schedule(host) }

    func forget(hostID host: String) {
        scheduled.removeValue(forKey: host)?.cancel()
        watches.removeValue(forKey: host)
        unsupportedHosts.remove(host)
    }

    /// Call with every daemon event, from any host.
    func receive(_ event: JSON, hostID host: String?) {
        guard event["type"].string == "control-state-changed" else { return }
        let domains = event["change"]["domains"].array
        if domains.contains(.string("reviews")) { reviewRevision &+= 1 }
        if domains.contains(.string("notifications")) { schedule(host) }
    }

    private func schedule(_ host: String?) {
        let key = Self.key(host)
        guard scheduled[key] == nil else { return }
        scheduled[key] = Task { [weak self, debounce] in
            do { try await Task.sleep(for: debounce) } catch { return }
            guard let self else { return }
            scheduled[key] = nil
            if host == hostID { await refresh() } else { await watchNotices(host) }
        }
    }

    // MARK: Reading

    private static func listQuery(filter: NotificationFilter, limit: Int, before: Int? = nil) -> [URLQueryItem] {
        var query = [URLQueryItem(name: "filter", value: filter.rawValue), URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(.init(name: "before_seq", value: String(before))) }
        return query
    }

    private func list(_ query: [URLQueryItem], host: String?) async throws -> JSON {
        guard let transport else { throw PilotError("Notifications are not connected.") }
        return try await transport(["api", "notifications"], "GET", query, nil, host)
    }

    /// Re-reads everything on screen from the head and replaces it, so a change on
    /// another device reaches scrolled rows and the cursor always sits under what
    /// is shown. Rows pushed off the bottom come back through `loadMore`.
    func refresh() async {
        guard !isLoading else { refreshAgain = true; return }
        let generation = listGeneration, started = mutationRevision, host = hostID, filter = filter
        let wanted = max(Self.pageSize, records.count)
        isLoading = true
        defer {
            if generation == listGeneration {
                isLoading = false
                if refreshAgain, mutationsInFlight == 0 { refreshAgain = false; schedule(host) }
            }
        }
        do {
            var rows: [NotificationRecord] = []
            var head: NotificationCounts?
            var next: Int?
            var page: [NotificationRecord]
            repeat {
                let limit = min(Self.maximumPage, wanted - rows.count)
                let response = try await list(Self.listQuery(filter: filter, limit: limit, before: next), host: host)
                guard generation == listGeneration else { return }
                page = response["items"].array.map(NotificationRecord.init)
                if head == nil {
                    setUnsupported(false, host: host)
                    let latest = NotificationCounts(response)
                    // Counts stay with the head: mark-all must not reach past what is shown.
                    head = latest
                    // A page of Needs you holds no notices, so it cannot reveal one.
                    if filter == .needsYou { await watchNotices(host) }
                    else { reveal(page, latestSeq: latest.latestSeq, host: host) }
                    guard generation == listGeneration else { return }
                }
                guard started == mutationRevision, mutationsInFlight == 0 else { refreshAgain = true; return }
                rows += page
                next = response["next_before_seq"].optionalInt
            } while rows.count < wanted && next != nil && !page.isEmpty
            // An older page landed during the walk, so this one is too short.
            guard records.count <= wanted else { refreshAgain = true; return }
            records = rows
            nextBeforeSeq = next
            if let head { counts = head }
            hasLoaded = true
            loadError = nil
        } catch {
            guard generation == listGeneration else { return }
            if Self.isUnsupported(error) { setUnsupported(true, host: host) }
            else { loadError = "Couldn’t load notifications. \(error.localizedDescription)" }
        }
    }

    func loadMore() async {
        guard let before = nextBeforeSeq, hasLoaded, !isLoadingMore else { return }
        let generation = listGeneration, started = mutationRevision, host = hostID, filter = filter
        isLoadingMore = true
        loadMoreError = nil
        defer { if generation == listGeneration { isLoadingMore = false } }
        do {
            let response = try await list(Self.listQuery(filter: filter, limit: Self.pageSize, before: before), host: host)
            guard generation == listGeneration else { return }
            guard started == mutationRevision, mutationsInFlight == 0, before == nextBeforeSeq else { loadAgain(); return }
            let known = Set(records.map(\.id))
            records += response["items"].array.map(NotificationRecord.init).filter { !known.contains($0.id) }
            nextBeforeSeq = response["next_before_seq"].optionalInt
            counts = NotificationCounts(response)
        } catch {
            guard generation == listGeneration else { return }
            loadMoreError = "Couldn’t load older notifications."
        }
    }

    /// A page that crossed a mutation or a refresh is unusable, and the sentinel
    /// that asked for it will not appear again by itself.
    private func loadAgain() {
        if mutationsInFlight > 0 { loadMoreAgain = true }
        else { Task { await loadMore() } }
    }

    func setFilter(_ value: NotificationFilter) {
        guard value != filter else { return }
        filter = value
        listGeneration += 1
        isLoading = false
        isLoadingMore = false
        refreshAgain = false
        loadMoreAgain = false
        hasLoaded = false
        loadError = nil
        loadMoreError = nil
        nextBeforeSeq = nil
        records = records.filter { $0.matches(value) }
        Task { await refresh() }
    }

    func present(message value: String) {
        message = value
        isPresented = true
    }

    func dismissMessage() { message = nil }

    /// Fetches one record, with its body, from the host that owns it.
    func record(id: String, hostID host: String?) async throws -> NotificationRecord {
        guard let transport else { throw PilotError("Notifications are not connected.") }
        return NotificationRecord(try await transport(["api", "notifications", id], "GET", [], nil, host))
    }

    // MARK: Marking read

    func markRead(_ record: NotificationRecord, hostID host: String?) async {
        guard !record.isRead else { return }
        guard host == hostID else {
            // A banner from a host the window has moved away from. Nothing here shows it.
            _ = try? await transport?(["api", "notifications", "read"], "POST", [], Self.readBody(ids: [record.id]), host)
            return
        }
        if records.first(where: { $0.id == record.id })?.isRead == true { return }
        await mutate(body: Self.readBody(ids: [record.id]), ids: [record.id], unread: min(1, counts.unread))
    }

    func markAllRead() async {
        guard canMarkAllRead else { return }
        // Only what James could see: a record newer than this stays unread.
        let seq = counts.latestSeq
        let ids = records.filter { !$0.isRead && $0.seq <= seq }.map(\.id)
        await mutate(body: .object(["up_to_seq": .number(Double(seq))]), ids: ids, unread: counts.unread)
    }

    private static func readBody(ids: [String]) -> JSON {
        .object(["ids": .array(ids.map(JSON.string))])
    }

    private func mutate(body: JSON, ids: [String], unread: Int) async {
        guard let transport else { return }
        let host = hostID, generation = hostGeneration
        let previous = records.filter { ids.contains($0.id) }
        let timestamp = Date().formatted(Date.ISO8601FormatStyle())
        records = records.map { ids.contains($0.id) ? $0.markedRead(at: timestamp) : $0 }
        counts.unread -= unread
        mutationRevision += 1
        mutationsInFlight += 1
        do {
            let response = try await transport(["api", "notifications", "read"], "POST", [], body, host)
            guard generation == hostGeneration else { return }
            finishMutation()
            // A later mutation's optimism is newer than this answer.
            if mutationsInFlight == 0 { counts = NotificationCounts(response) }
        } catch {
            guard generation == hostGeneration else { return }
            let restored = Dictionary(previous.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            records = records.map { restored[$0.id] ?? $0 }
            counts.unread += unread
            if Self.isUnsupported(error) { setUnsupported(true, host: host) }
            else { message = "Couldn’t mark as read. \(error.localizedDescription)" }
            refreshAgain = true
            finishMutation()
        }
    }

    private func finishMutation() {
        mutationRevision += 1
        mutationsInFlight -= 1
        guard mutationsInFlight == 0 else { return }
        if refreshAgain { refreshAgain = false; schedule(hostID) }
        if loadMoreAgain { loadMoreAgain = false; Task { await loadMore() } }
    }

    // MARK: Banners for agent notices

    /// Thread alerts come from thread state, so a notice is the one thing
    /// `NativePlatform` cannot see for itself. Reads the first page whatever the
    /// list shows, and for hosts the list is not following.
    private func watchNotices(_ host: String?) async {
        do {
            let response = try await list(Self.listQuery(filter: .bots, limit: 20), host: host)
            setUnsupported(false, host: host)
            reveal(response["items"].array.map(NotificationRecord.init), latestSeq: NotificationCounts(response).latestSeq, host: host)
        } catch {
            if Self.isUnsupported(error) { setUnsupported(true, host: host) }
        }
    }

    private func reveal(_ rows: [NotificationRecord], latestSeq: Int, host: String?) {
        let key = Self.key(host)
        guard var watch = watches[key] else {
            // The first load seeds: a launch does not replay history.
            watches[key] = NoticeWatch(baseline: latestSeq)
            return
        }
        let fresh = rows.filter { $0.isAgentNotice && $0.seq > watch.baseline && !watch.seen.contains($0.id) }
        watch.seen.formUnion(fresh.map(\.id))
        watches[key] = watch
        let unread = fresh.filter { !$0.isRead }.sorted { $0.seq < $1.seq }
        for record in unread.suffix(Self.maximumBannersPerFetch) { onNewNotice?(record, host) }
    }

    // MARK: Older daemons

    private func setUnsupported(_ value: Bool, host: String?) {
        let key = Self.key(host)
        if value { unsupportedHosts.insert(key) } else { unsupportedHosts.remove(key) }
        guard host == hostID else { return }
        unsupported = value
        if value {
            records = []
            counts = NotificationCounts()
            isPresented = false
        }
    }

    /// An older daemon answers 404 locally and names the method over the relay.
    static func isUnsupported(_ error: Error) -> Bool {
        if (error as? PilotError)?.status == 404 { return true }
        let text = error.localizedDescription.lowercased()
        return ["unsupported remote rpc", "unknown method", "unknown rpc", "not supported", "method not found"].contains { text.contains($0) }
    }
}
