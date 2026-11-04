import XCTest
@testable import FalconDeckNative

/// Stands in for the daemon. A `gate` holds a method's answer until released,
/// which is how the races below are staged.
private actor CentreRelay: RelayServing {
    typealias Handler = @Sendable (String, JSON) throws -> JSON
    private var handler: Handler
    private(set) var calls: [(String, JSON)] = []
    private var gated: Set<String> = []
    private var gateSkips = 0
    private var held: [CheckedContinuation<Void, Never>] = []
    init(_ handler: @escaping Handler) { self.handler = handler }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .object(["thread": .object(["id": .string(task.id), "workspace_id": .string(task.projectID), "title": .string("Thread"), "status": .string("idle")])]) }
    func call(_ method: String, params: JSON) async throws -> JSON {
        calls.append((method, params))
        let result = Result { try handler(method, params) }
        if gated.contains(method) {
            if gateSkips > 0 { gateSkips -= 1 }
            else { gated.remove(method); await withCheckedContinuation { held.append($0) } }
        }
        return try result.get()
    }
    func replace(_ handler: @escaping Handler) { self.handler = handler }
    func gate(_ method: String) { gated.insert(method) }
    func gateAfter(_ method: String, skipping count: Int) { gated.insert(method); gateSkips = count }
    func release() { for gate in held { gate.resume() }; held = [] }
    func holding() -> Bool { !held.isEmpty }
    func count(_ method: String) -> Int { calls.filter { $0.0 == method }.count }
    func last(_ method: String) -> JSON? { calls.last { $0.0 == method }?.1 }
}

/// Stands in for the relay's HTTP side.
private actor CentreHTTP: PushHTTP {
    var capabilityBody = #"{"apns":[],"reports":{"max_bytes":262144,"max_ttl_seconds":2592000}}"#
    var capabilityStatus = 200
    var listed: [String] = []
    var reports: [String: JSON] = [:]
    private(set) var paths: [String] = []
    private(set) var authorization: [String?] = []
    private(set) var inFlight = 0
    private(set) var mostInFlight = 0
    func set(capability body: String, status: Int = 200) { capabilityBody = body; capabilityStatus = status }
    func put(_ id: String, _ response: JSON) { reports[id] = response; listed.append(id) }
    func drop(_ id: String) { reports[id] = nil; listed.removeAll { $0 == id } }
    func send(_ request: URLRequest) async throws -> (Data, Int) {
        let path = request.url?.path() ?? ""
        paths.append(path); authorization.append(request.value(forHTTPHeaderField: "Authorization"))
        if path.hasSuffix("/v1/push-capabilities") { return (Data(capabilityBody.utf8), capabilityStatus) }
        inFlight += 1; mostInFlight = max(mostInFlight, inFlight)
        defer { inFlight -= 1 }
        try await Task.sleep(for: .milliseconds(5))
        if path.hasSuffix("/reports") {
            let rows = listed.map { JSON.object(["report_id": .string($0), "created_at": .string("2026-11-01T09:00:00Z"), "expires_at": .string("2036-11-01T09:00:00Z"), "size_bytes": .number(100)]) }
            return (try JSON.object(["reports": .array(rows)]).data(), 200)
        }
        guard let id = path.split(separator: "/").last, let report = reports[String(id)] else { return (Data("{}".utf8), 404) }
        return (try report.data(), 200)
    }
    func reportCalls() -> [String] { paths.filter { $0.contains("/reports") } }
}

private enum Wire {
    static let key = Data(repeating: 7, count: 32)
    static func session(key: Data? = Wire.key) -> SavedSession {
        SavedSession(relay: URL(string: "https://relay.test")!, sessionID: "session-1", deviceID: "device", token: "client-token", secret: Data(repeating: 9, count: 32), daemonKey: "k", daemonIdentity: "i", dataKey: key)
    }
    static func record(_ seq: Int, id: String? = nil, kind: String = "turn_complete", read: Bool = false, resolved: Bool = false, day: String = "2026-11-04", extra: [String: JSON] = [:]) -> JSON {
        var fields: [String: JSON] = ["id": .string(id ?? "N-\(seq)"), "seq": .number(Double(seq)), "kind": .string(kind), "title": .string("Title \(seq)"), "preview": .string("Preview \(seq)"),
                                      "created_at": .string("\(day)T10:00:00Z"), "importance": .string("normal"), "has_body": .bool(false), "repeat_count": .number(0)]
        if read { fields["read_at"] = .string("\(day)T11:00:00Z") }
        if resolved { fields["resolved_at"] = .string("\(day)T11:00:00Z") }
        for (key, value) in extra { fields[key] = value }
        return .object(fields)
    }
    static func list(_ items: [JSON], next: Int? = nil, unread: Int? = nil, needsYou: Int = 0, latest: Int? = nil) -> JSON {
        var fields: [String: JSON] = ["items": .array(items), "unread_count": .number(Double(unread ?? items.count)), "needs_you_count": .number(Double(needsYou)),
                                      "latest_seq": .number(Double(latest ?? items.map(\.["seq"].int).max() ?? 0))]
        if let next { fields["next_before_seq"] = .number(Double(next)) }
        return .object(fields)
    }
    /// Newest first, like the store.
    static func rows(_ seqs: ClosedRange<Int>, kind: String = "turn_complete", read: Bool = false, resolved: Bool = false) -> [JSON] {
        seqs.reversed().map { record($0, kind: kind, read: read, resolved: resolved) }
    }
    /// The daemon's paging: rows below `before_seq`, up to `limit`, and a cursor while more remain.
    static func paged(_ rows: [JSON]) -> CentreRelay.Handler {
        { _, params in
            let matching = rows.filter { row in params["before_seq"].optionalInt.map { row["seq"].int < $0 } ?? true }
            let page = Array(matching.prefix(params["limit"].optionalInt ?? 50))
            return list(page, next: matching.count > page.count ? page.last?["seq"].int : nil, unread: rows.filter { $0["read_at"] == .null }.count, latest: rows.first?["seq"].int ?? 0)
        }
    }
    static func counts(unread: Int, needsYou: Int = 0, latest: Int = 10) -> JSON {
        .object(["unread_count": .number(Double(unread)), "needs_you_count": .number(Double(needsYou)), "latest_seq": .number(Double(latest))])
    }
    static func plaintext(_ id: String = "rpt_1", session: String = "session-1", notification: String = "N-9", version: Int = 1) -> JSON {
        .object(["version": .number(Double(version)), "report_id": .string(id), "session_id": .string(session), "notification_id": .string(notification), "title": .string("Soak finished"),
                 "summary": .string("No data loss"), "body": .string("**All clear.**"), "bot": .string("Juno"), "thread_id": .string("t1"), "workspace_id": .string("w1"),
                 "importance": .string("high"), "created_at": .string("2026-11-04T08:00:00Z")])
    }
    static func report(_ id: String = "rpt_1", plaintext: JSON? = nil, key: Data = Wire.key) throws -> JSON {
        .object(["report_id": .string(id), "created_at": .string("2026-11-04T08:00:00Z"), "expires_at": .string("2036-11-04T08:00:00Z"),
                 "envelope": try RelayCrypto.encrypt(plaintext ?? Wire.plaintext(id), key: key)])
    }
}

private func settle(_ condition: @MainActor () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
    for _ in 0..<400 {
        if await condition() { return }
        try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("Condition never held", file: file, line: line)
}

@MainActor private final class Rig {
    let relay: CentreRelay
    let http = CentreHTTP()
    let defaults: UserDefaults
    let suite = "NotificationCentreTests-\(UUID())"
    let replies = FileManager.default.temporaryDirectory.appending(path: "NotificationReplies-\(UUID())", directoryHint: .isDirectory)
    let store: NotificationCentreStore
    let model: AppModel
    init(connected: Bool = true, session: SavedSession? = Wire.session(), _ handler: @escaping CentreRelay.Handler = { _, _ in Wire.list([]) }) {
        defaults = UserDefaults(suiteName: suite)!
        relay = CentreRelay(handler)
        store = NotificationCentreStore(defaults: defaults, reportClient: NotificationReportClient(http: http), replyRoot: replies, offlineSettle: .zero)
        model = AppModel.testing(relay: relay, sessionLoader: { session }, notificationCentre: store)
        model.connected = connected; model.hasSession = session != nil; model.restoringSession = false
    }
    deinit {
        UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: replies)
    }
    /// A new store on the same disk, as after a relaunch.
    func relaunched(connected: Bool) -> (store: NotificationCentreStore, model: AppModel) {
        let store = NotificationCentreStore(defaults: defaults, reportClient: NotificationReportClient(http: http), replyRoot: replies, offlineSettle: .zero)
        let session = Wire.session()
        let model = AppModel.testing(relay: relay, sessionLoader: { session }, notificationCentre: store)
        model.connected = connected; model.hasSession = true; model.restoringSession = false
        return (store, model)
    }
}

@MainActor final class NotificationCentreTests: XCTestCase {
    private func rows(_ store: NotificationCentreStore, offline: Bool = false) -> [String] { store.visibleRecords(offline: offline).map(\.id) }

    // MARK: Decoding

    func testDecodesARecordExactlyAsTheDaemonWritesIt() throws {
        let text = ##"{"id":"N-41","seq":41,"kind":"agent_notice","title":"Soak","preview":"Done","bot":"Juno","thread_id":"t","workspace_id":"w","created_at":"2026-11-04T10:00:00.123456789Z","read_at":"2026-11-04T10:05:00Z","resolved_at":"2026-11-04T10:06:00Z","target":{"type":"thread","workspace_id":"w","thread_id":"t"},"importance":"high","has_body":true,"body":"# Hi","report":{"report_id":"rpt_1","expires_at":"2026-12-04T10:00:00Z","hosted":true},"repeat_count":2}"##
        let record = try XCTUnwrap(NotificationRecord(JSON.decode(Data(text.utf8))))
        XCTAssertEqual(record.id, "N-41"); XCTAssertEqual(record.seq, 41); XCTAssertEqual(record.kind, .agentNotice)
        XCTAssertEqual(record.bot, "Juno"); XCTAssertEqual(record.target, .thread(workspaceID: "w", threadID: "t"))
        XCTAssertTrue(record.hasBody); XCTAssertEqual(record.body, "# Hi"); XCTAssertEqual(record.repeatCount, 2)
        XCTAssertEqual(record.report?.reportID, "rpt_1"); XCTAssertEqual(record.report?.hosted, true); XCTAssertNotNil(record.report?.expiresAt)
        XCTAssertTrue(record.isRead); XCTAssertTrue(record.isResolved); XCTAssertFalse(record.isWaiting)
    }

    func testOmittedOptionalsAndATargetForAReview() throws {
        let text = #"{"id":"N-2","seq":2,"kind":"review","title":"Pricing","preview":"Ship?","created_at":"2026-11-04T10:00:00Z","target":{"type":"review","review_id":"R-12"},"importance":"normal","has_body":false,"repeat_count":0}"#
        let record = try XCTUnwrap(NotificationRecord(JSON.decode(Data(text.utf8))))
        XCTAssertNil(record.bot); XCTAssertNil(record.readAt); XCTAssertNil(record.report); XCTAssertTrue(record.isWaiting)
        XCTAssertEqual(record.action, .review("R-12"))
    }

    func testAFutureKindStillShowsAndAnUnreadableRecordHidesNothing() {
        let response = NotificationListResponse(Wire.list([Wire.record(3, kind: "something_new"), .object(["id": .string("broken")]), Wire.record(1)]))
        XCTAssertEqual(response.items.map(\.id), ["N-3", "N-1"])
        XCTAssertEqual(response.items[0].kind, .other)
        XCTAssertEqual(response.counts.latestSeq, 3)
    }

    func testTappingFollowsTheRecord() {
        let thread = NotificationRecord(Wire.record(1, extra: ["target": .object(["type": .string("thread"), "workspace_id": .string("w"), "thread_id": .string("t")])]))
        XCTAssertEqual(thread?.action, .thread(workspaceID: "w", threadID: "t"))
        let report = NotificationRecord(Wire.record(2, kind: "agent_notice", extra: ["has_body": .bool(true), "target": .object(["type": .string("thread"), "workspace_id": .string("w"), "thread_id": .string("t")])]))
        XCTAssertEqual(report?.action, .detail, "A body opens the report; the target is the way back")
        XCTAssertEqual(NotificationRecord(Wire.record(3, kind: "agent_notice"))?.action, .detail, "A notice opens even without a body")
        XCTAssertEqual(report?.sourceThread?.threadID, "t")
    }

    // MARK: Paging

    func testPagesContinueFromTheCursorAndEnd() async throws {
        let rig = Rig(Wire.paged(Wire.rows(1...60)))
        await rig.store.refresh(model: rig.model)
        XCTAssertEqual(rows(rig.store).count, 50); XCTAssertTrue(rig.store.hasMore)
        await rig.store.loadMore(model: rig.model)
        let sent = await rig.relay.last("notifications.list")
        XCTAssertEqual(sent?["before_seq"].int, 11); XCTAssertEqual(sent?["limit"].int, 50); XCTAssertEqual(sent?["filter"].string, "all")
        XCTAssertEqual(rig.store.visibleRecords(offline: false).map(\.seq), Array((1...60).reversed()))
        XCTAssertFalse(rig.store.hasMore)
        XCTAssertEqual(rig.store.counts.unread, 60, "Counts are store-wide, never derived from the rows")
    }

    func testARecordRefreshedBetweenPagesShowsOnce() async throws {
        let rig = Rig { _, params in
            params["before_seq"].optionalInt == nil ? Wire.list(Wire.rows(51...100), next: 51) : Wire.list([Wire.record(50), Wire.record(49, id: "N-100")])
        }
        await rig.store.refresh(model: rig.model)
        await rig.store.loadMore(model: rig.model)
        XCTAssertEqual(rows(rig.store).count, 51)
        XCTAssertEqual(rig.store.visibleRecords(offline: false).first?.seq, 100, "The refreshed copy keeps its place at the top")
    }

    func testADaemonThatRepeatsAPageCannotHangARefresh() async throws {
        let rig = Rig { _, _ in Wire.list([Wire.record(5)], next: 5) }
        await rig.store.refresh(model: rig.model)
        XCTAssertEqual(rows(rig.store), ["N-5"])
    }

    func testARefreshDoesNotShortenWhatWasScrolledTo() async throws {
        let rig = Rig(Wire.paged(Wire.rows(1...120)))
        await rig.store.refresh(model: rig.model)
        await rig.store.loadMore(model: rig.model)
        XCTAssertEqual(rows(rig.store).count, 100)
        await rig.store.refresh(model: rig.model)
        XCTAssertEqual(rows(rig.store).count, 100)
        XCTAssertEqual(rig.store.pages[.all]?.nextBeforeSeq, 21, "Paging continues from the deepest row")
    }

    func testNewRecordsLeaveNoGapBelowThem() async throws {
        let rig = Rig(Wire.paged(Wire.rows(51...100)))
        await rig.store.refresh(model: rig.model)
        XCTAssertEqual(rig.store.visibleRecords(offline: false).map(\.seq), Array((51...100).reversed()))
        // A hundred new records push everything loaded below the first page.
        await rig.relay.replace(Wire.paged(Wire.rows(51...200)))
        await rig.store.refresh(model: rig.model)
        XCTAssertEqual(rig.store.visibleRecords(offline: false).map(\.seq), Array((151...200).reversed()), "Older rows fall off and come back through load more")
        XCTAssertEqual(rig.store.pages[.all]?.nextBeforeSeq, 151)
        await rig.store.loadMore(model: rig.model)
        await rig.store.loadMore(model: rig.model)
        XCTAssertEqual(rig.store.visibleRecords(offline: false).map(\.seq), Array((51...200).reversed()), "150 to 101 are not skipped")
        XCTAssertFalse(rig.store.hasMore)
    }

    func testARefreshCarriesChangesFromAnotherDeviceThroughTheWholeList() async throws {
        let rig = Rig(Wire.paged(Wire.rows(1...120, kind: "input_required")))
        await rig.store.refresh(model: rig.model)
        await rig.store.loadMore(model: rig.model)
        await rig.relay.replace(Wire.paged(Wire.rows(1...120, kind: "input_required", read: true, resolved: true)))
        await rig.store.refresh(model: rig.model)
        let visible = rig.store.visibleRecords(offline: false)
        XCTAssertEqual(visible.count, 100)
        XCTAssertTrue(visible.allSatisfy { $0.isRead && $0.isResolved }, "No row beyond the first page keeps an old state")
    }

    func testARefreshWalksPagesOfTheMaximumSize() async throws {
        let rig = Rig(Wire.paged(Wire.rows(1...400)))
        await rig.store.refresh(model: rig.model)
        for _ in 0..<4 { await rig.store.loadMore(model: rig.model) }
        XCTAssertEqual(rows(rig.store).count, 250)
        let before = await rig.relay.calls.count
        await rig.store.refresh(model: rig.model)
        let sent = await rig.relay.calls.dropFirst(before).map(\.1)
        XCTAssertEqual(sent.map(\.["limit"].int), [200, 50])
        XCTAssertEqual(sent.map { $0["before_seq"].optionalInt }, [nil, 201])
        XCTAssertEqual(rows(rig.store).count, 250)
        XCTAssertEqual(rig.store.pages[.all]?.nextBeforeSeq, 151)
    }

    func testAPageThatFailsPartWayCommitsNothing() async throws {
        let rig = Rig(Wire.paged(Wire.rows(1...300)))
        await rig.store.refresh(model: rig.model)
        for _ in 0..<4 { await rig.store.loadMore(model: rig.model) }
        let shown = rows(rig.store), cursor = rig.store.pages[.all]?.nextBeforeSeq
        await rig.relay.replace { _, params in
            if params["before_seq"].optionalInt != nil { throw PilotError("The computer took too long to respond.") }
            return Wire.list(Wire.rows(701...900), next: 701, unread: 200, latest: 900)
        }
        await rig.store.refresh(model: rig.model)
        XCTAssertEqual(rows(rig.store), shown, "All of the walk lands, or none of it")
        XCTAssertEqual(rig.store.pages[.all]?.nextBeforeSeq, cursor)
        XCTAssertNotEqual(rig.store.counts.latestSeq, 900)
        XCTAssertNil(rig.store.refreshError, "What is on screen is still worth showing")
    }

    func testAReadDuringALaterPageThrowsTheWalkAway() async throws {
        let rig = Rig { method, params in
            if method == "notifications.mark_read" { return Wire.counts(unread: 99, latest: 300) }
            return try Wire.paged(Wire.rows(1...300))(method, params)
        }
        await rig.store.refresh(model: rig.model)
        for _ in 0..<4 { await rig.store.loadMore(model: rig.model) }
        await rig.relay.gateAfter("notifications.list", skipping: 1)
        let refresh = Task { await rig.store.refresh(model: rig.model) }
        await settle { await rig.relay.holding() }
        await rig.store.markRead("N-300", model: rig.model)
        await rig.relay.release(); await refresh.value
        XCTAssertEqual(rig.store.record("N-300")?.isRead, true)
    }

    func testMarkAllUsesTheSeqOfTheFirstPageOfAWalk() async throws {
        let rig = Rig(Wire.paged(Wire.rows(1...300)))
        await rig.store.refresh(model: rig.model)
        for _ in 0..<4 { await rig.store.loadMore(model: rig.model) }
        // A record lands while the walk is on its second page.
        await rig.relay.replace { _, params in
            params["before_seq"].optionalInt == nil ? Wire.list(Wire.rows(101...300), next: 101, unread: 300, latest: 300)
                : Wire.list(Wire.rows(51...100), next: 51, unread: 301, latest: 301)
        }
        await rig.store.refresh(model: rig.model)
        XCTAssertEqual(rig.store.counts.latestSeq, 300, "301 was never on screen, so mark-all must not cover it")
    }

    func testAFailedPageCanBeRetriedAndKeepsTheRows() async throws {
        let rig = Rig { _, params in
            if params["before_seq"].optionalInt != nil { throw PilotError("The computer took too long to respond.") }
            return Wire.list(Wire.rows(51...100), next: 51)
        }
        await rig.store.refresh(model: rig.model)
        await rig.store.loadMore(model: rig.model)
        XCTAssertTrue(rig.store.loadMoreFailed); XCTAssertEqual(rows(rig.store).count, 50); XCTAssertTrue(rig.store.hasMore)
    }

    // MARK: Filters

    func testEachFilterIsAskedOfTheDaemonAndKeptSeparately() async throws {
        let rig = Rig { _, params in
            switch params["filter"].string {
            case "needs_you": Wire.list([Wire.record(4, kind: "review")], unread: 5, needsYou: 1, latest: 9)
            case "bots": Wire.list([Wire.record(3, extra: ["bot": .string("Juno")])], unread: 5, needsYou: 1, latest: 9)
            default: Wire.list([Wire.record(9), Wire.record(4, kind: "review")], unread: 5, needsYou: 1, latest: 9)
            }
        }
        await rig.store.refresh(model: rig.model)
        XCTAssertEqual(rows(rig.store), ["N-9", "N-4"])
        rig.store.setFilter(.needsYou)
        XCTAssertEqual(rows(rig.store), [], "Nothing stale from another filter")
        await rig.store.refresh(model: rig.model)
        XCTAssertEqual(rows(rig.store), ["N-4"]); XCTAssertEqual(rig.store.counts.needsYou, 1)
        rig.store.setFilter(.bots)
        await rig.store.refresh(model: rig.model)
        XCTAssertEqual(rows(rig.store), ["N-3"])
        rig.store.setFilter(.all)
        XCTAssertEqual(rows(rig.store), ["N-9", "N-4"], "Switching back is instant")
    }

    func testClientFilterRulesMatchTheDaemon() throws {
        let waiting = try XCTUnwrap(NotificationRecord(Wire.record(1, kind: "input_required")))
        let answered = try XCTUnwrap(NotificationRecord(Wire.record(2, kind: "review", resolved: true)))
        let notice = try XCTUnwrap(NotificationRecord(Wire.record(3, kind: "agent_notice")))
        let botError = try XCTUnwrap(NotificationRecord(Wire.record(4, kind: "error", extra: ["bot": .string("Juno")])))
        XCTAssertTrue(waiting.matches(.needsYou)); XCTAssertFalse(answered.matches(.needsYou)); XCTAssertFalse(notice.matches(.needsYou))
        XCTAssertTrue(notice.matches(.bots)); XCTAssertTrue(botError.matches(.bots)); XCTAssertFalse(waiting.matches(.bots))
    }

    // MARK: Day grouping

    func testGroupsByDayInTheCalendarsZone() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Pacific/Auckland")!
        calendar.locale = Locale(identifier: "en_GB")
        let now = try XCTUnwrap(ReviewDecoding.date("2026-11-04T10:00:00Z")) // 23:00 on the 4th in Auckland
        func row(_ seq: Int, _ at: String) -> NotificationRecord { NotificationRecord(id: "N-\(seq)", seq: seq, kind: .turnComplete, title: "", preview: "", createdAt: ReviewDecoding.date(at)!) }
        let sections = NotificationDays.sections([
            row(9, "2026-11-04T09:30:00Z"), row(8, "2026-11-03T12:00:00Z"), // Both the 4th in Auckland
            row(7, "2026-11-03T10:30:00Z"), // 23:30 on the 3rd
            row(6, "2026-11-01T10:00:00Z"), // Sunday the 1st
            row(5, "2026-10-12T10:00:00Z"), row(4, "2025-10-12T10:00:00Z"),
        ], now: now, calendar: calendar)
        XCTAssertEqual(sections.map { $0.records.map(\.seq) }, [[9, 8], [7], [6], [5], [4]])
        XCTAssertEqual(sections[0].title, "Today"); XCTAssertEqual(sections[1].title, "Yesterday"); XCTAssertEqual(sections[2].title, "Sunday")
        XCTAssertTrue(sections[3].title.contains("Oct")); XCTAssertFalse(sections[3].title.contains("2026"))
        XCTAssertTrue(sections[4].title.contains("2025"))
    }

    // MARK: Read state

    func testAReadShowsAtOnceAndTheDaemonsCountsWin() async throws {
        let rig = Rig { method, _ in method == "notifications.mark_read" ? Wire.counts(unread: 4, needsYou: 2, latest: 12) : Wire.list([Wire.record(10), Wire.record(9)], unread: 6, latest: 10) }
        await rig.store.refresh(model: rig.model)
        await rig.relay.gate("notifications.mark_read")
        let read = Task { await rig.store.markRead("N-10", model: rig.model) }
        await settle { await rig.relay.holding() }
        XCTAssertEqual(rig.store.record("N-10")?.isRead, true, "Read before the daemon answers")
        XCTAssertEqual(rig.store.counts.unread, 5)
        await rig.relay.release(); await read.value
        let sent = await rig.relay.last("notifications.mark_read")
        XCTAssertEqual(sent, .object(["ids": .array([.string("N-10")])]))
        XCTAssertEqual(rig.store.counts, NotificationCounts(unread: 4, needsYou: 2, latestSeq: 12))
    }

    func testARefusedReadIsPutBack() async throws {
        let rig = Rig { method, _ in
            if method == "notifications.mark_read" { throw PilotError("disk full") }
            return Wire.list([Wire.record(10)], unread: 6, latest: 10)
        }
        await rig.store.refresh(model: rig.model)
        await rig.store.markRead("N-10", model: rig.model)
        XCTAssertEqual(rig.store.record("N-10")?.isRead, false)
        XCTAssertEqual(rig.store.counts.unread, 6)
        XCTAssertNotNil(rig.store.actionError)
        XCTAssertTrue(rig.store.offlineReads.isEmpty, "A reachable computer said no; this is not an offline read")
    }

    func testReadingWhatIsAlreadyReadSendsNothing() async throws {
        let rig = Rig { _, _ in Wire.list([Wire.record(10, read: true)], unread: 0) }
        await rig.store.refresh(model: rig.model)
        await rig.store.markRead("N-10", model: rig.model)
        let sent = await rig.relay.count("notifications.mark_read")
        XCTAssertEqual(sent, 0)
    }

    func testMarkAllSendsTheNewestSeqNotACount() async throws {
        let rig = Rig { method, _ in method == "notifications.mark_read" ? Wire.counts(unread: 1, latest: 90) : Wire.list([Wire.record(87), Wire.record(40)], unread: 2, latest: 87) }
        await rig.store.refresh(model: rig.model)
        await rig.store.markAllRead(model: rig.model)
        let sent = await rig.relay.last("notifications.mark_read")
        XCTAssertEqual(sent, .object(["up_to_seq": .number(87)]))
        XCTAssertEqual(rig.store.visibleRecords(offline: false).filter(\.isRead).count, 2)
        XCTAssertEqual(rig.store.counts.unread, 1, "A record that arrived since stays unread")
    }

    func testAFailedMarkAllRestoresEveryRow() async throws {
        let rig = Rig { method, _ in
            if method == "notifications.mark_read" { throw PilotError("disk full") }
            return Wire.list([Wire.record(3), Wire.record(2, read: true), Wire.record(1)], unread: 2, latest: 3)
        }
        await rig.store.refresh(model: rig.model)
        await rig.store.markAllRead(model: rig.model)
        XCTAssertEqual(rig.store.visibleRecords(offline: false).map(\.isRead), [false, true, false], "Only what this changed goes back")
        XCTAssertEqual(rig.store.counts.unread, 2)
        XCTAssertNotNil(rig.store.actionError)
    }

    func testMarkAllNeedsTheComputer() async throws {
        let rig = Rig { _, _ in Wire.list([Wire.record(3)], unread: 1) }
        await rig.store.refresh(model: rig.model)
        rig.model.connected = false
        await rig.store.markAllRead(model: rig.model)
        XCTAssertEqual(rig.store.record("N-3")?.isRead, false)
    }

    func testAStaleListCannotUndoANewerRead() async throws {
        let rig = Rig { method, _ in method == "notifications.mark_read" ? Wire.counts(unread: 0, latest: 10) : Wire.list([Wire.record(10)], unread: 1, latest: 10) }
        await rig.store.refresh(model: rig.model)
        await rig.relay.gate("notifications.list")
        let refresh = Task { await rig.store.refresh(model: rig.model) }
        await settle { await rig.relay.holding() }
        await rig.store.markRead("N-10", model: rig.model)
        await rig.relay.replace { _, _ in Wire.list([Wire.record(10, read: true)], unread: 0, latest: 10) }
        await rig.relay.release(); await refresh.value
        XCTAssertEqual(rig.store.record("N-10")?.isRead, true, "The response from before the read is thrown away")
        XCTAssertEqual(rig.store.counts.unread, 0)
        await settle { await rig.relay.count("notifications.list") == 3 }
    }

    func testAListThatOvertakesAReadStillShowsItRead() async throws {
        let rig = Rig { method, _ in method == "notifications.mark_read" ? Wire.counts(unread: 0, latest: 10) : Wire.list([Wire.record(10)], unread: 1, latest: 10) }
        await rig.store.refresh(model: rig.model)
        await rig.relay.gate("notifications.mark_read")
        let read = Task { await rig.store.markRead("N-10", model: rig.model) }
        await settle { await rig.relay.holding() }
        await rig.store.refresh(model: rig.model) // Started after the read; the daemon has not applied it.
        XCTAssertEqual(rig.store.record("N-10")?.isRead, true)
        XCTAssertEqual(rig.store.counts.unread, 0)
        await rig.relay.release(); await read.value
    }

    // MARK: Visibility

    func testAnOlderDaemonHidesTheEntry() async throws {
        for message in ["unknown method notifications.list", "The computer could not complete this request (method_unavailable)."] {
            let rig = Rig { _, _ in throw PilotError(message) }
            await rig.store.refresh(model: rig.model)
            XCTAssertTrue(rig.store.unsupported, message); XCTAssertFalse(rig.store.entryVisible)
            XCTAssertNil(rig.store.refreshError)
        }
    }

    func testAnUpdatedDaemonBringsTheEntryBack() async throws {
        let rig = Rig { _, _ in throw PilotError("unknown method") }
        await rig.store.refresh(model: rig.model)
        await rig.relay.replace { _, _ in Wire.list([Wire.record(1)]) }
        rig.model.receive(.init(connectionID: rig.model.connectionID, event: .status("Connecting…", connected: false)))
        rig.model.receive(.init(connectionID: rig.model.connectionID, event: .status("Connected", connected: true)))
        await settle { rig.store.entryVisible }
        XCTAssertEqual(rows(rig.store), ["N-1"])
    }

    func testATransientFailureIsNotMistakenForAnOldDaemon() async throws {
        let rig = Rig { _, _ in throw PilotError("The computer took too long to respond.") }
        await rig.store.refresh(model: rig.model)
        XCTAssertFalse(rig.store.unsupported); XCTAssertEqual(rig.store.refreshError, "Couldn't load notifications. Pull to refresh.")
    }

    func testEveryMethodThisFeatureCallsIsPermitted() {
        for method in ["notifications.list", "notification.get", "notifications.mark_read", "reviews.list", "review.get", "review.respond"] {
            XCTAssertTrue(RelayClient.permittedMethods.contains(method), "\(method) would fail as if offline")
        }
    }

    // MARK: Live updates and lifecycle

    func testRefreshesOnItsOwnDomainOnly() async throws {
        let rig = Rig { _, _ in Wire.list([Wire.record(1)]) }
        rig.store.controlStateChanged(.object(["change": .object(["domains": .array([.string("reviews")])])]), model: rig.model)
        try await Task.sleep(for: .milliseconds(350))
        var calls = await rig.relay.count("notifications.list")
        XCTAssertEqual(calls, 0)
        for _ in 0..<5 { rig.store.controlStateChanged(.object(["change": .object(["domains": .array([.string("notifications")])])]), model: rig.model) }
        await settle { await rig.relay.count("notifications.list") >= 1 }
        try await Task.sleep(for: .milliseconds(350))
        calls = await rig.relay.count("notifications.list")
        XCTAssertEqual(calls, 1, "A burst is one fetch")
    }

    func testTheModelRoutesControlEventsToTheStore() async throws {
        let rig = Rig { _, _ in Wire.list([Wire.record(1)]) }
        rig.model.applyEnvelope(.object(["seq": .number(1), "event": .object(["type": .string("control-state-changed"), "change": .object(["domains": .array([.string("notifications")])])])]))
        await settle { await rig.relay.count("notifications.list") == 1 }
    }

    func testAResponseFromAnEarlierConnectionIsDropped() async throws {
        let rig = Rig { _, _ in Wire.list([Wire.record(1)], unread: 1) }
        await rig.relay.gate("notifications.list")
        let refresh = Task { await rig.store.refresh(model: rig.model) }
        await settle { await rig.relay.holding() }
        rig.store.reset(clearData: true, forgotten: false)
        await rig.relay.release(); await refresh.value
        XCTAssertTrue(rows(rig.store).isEmpty); XCTAssertEqual(rig.store.counts.unread, 0)
    }

    func testAReconnectKeepsTheListButANewPairingClearsIt() async throws {
        let rig = Rig { _, _ in Wire.list([Wire.record(1)], unread: 1) }
        await rig.store.refresh(model: rig.model)
        rig.store.reset(clearData: false, forgotten: false)
        XCTAssertEqual(rows(rig.store), ["N-1"])
        rig.store.reset(clearData: true, forgotten: false)
        XCTAssertTrue(rows(rig.store).isEmpty)
    }

    // MARK: Demo

    func testDemoHistoryNeedsNoComputer() async throws {
        let rig = Rig(connected: false)
        rig.model.demo = true
        await rig.store.refresh(model: rig.model)
        XCTAssertGreaterThanOrEqual(rig.store.visibleRecords(offline: false).count, 8)
        let unread = rig.store.counts.unread
        XCTAssertGreaterThan(unread, 0)
        let id = try XCTUnwrap(rig.store.visibleRecords(offline: false).first { !$0.isRead }?.id)
        await rig.store.markRead(id, model: rig.model)
        await rig.store.refresh(model: rig.model)
        XCTAssertEqual(rig.store.counts.unread, unread - 1, "Reading survives a demo refresh")
        rig.store.setFilter(.needsYou); await rig.store.refresh(model: rig.model)
        XCTAssertTrue(rig.store.visibleRecords(offline: false).allSatisfy(\.isWaiting))
        await rig.store.markAllRead(model: rig.model)
        XCTAssertEqual(rig.store.counts.unread, 0)
        let calls = await rig.relay.calls.count
        XCTAssertEqual(calls, 0)
    }

    // MARK: Reports

    func testAReportOpensWithTheSessionKey() throws {
        let report = try NotificationReport.open(try Wire.report(), reportID: "rpt_1", session: Wire.session())
        XCTAssertEqual(report.notificationID, "N-9"); XCTAssertEqual(report.title, "Soak finished"); XCTAssertEqual(report.body, "**All clear.**")
        XCTAssertEqual(report.record.kind, .agentNotice); XCTAssertEqual(report.record.target, .thread(workspaceID: "w1", threadID: "t1"))
        XCTAssertEqual(report.record.report?.reportID, "rpt_1"); XCTAssertEqual(report.record.preview, "No data loss")
    }

    func testAReportDecryptsWhatTheDaemonsFormatProduces() throws {
        // `encrypt_bytes` from crates/falcondeck-core/src/crypto.rs: version byte, 12-byte nonce, ciphertext, 16-byte tag.
        let sealed = try RelayCrypto.encrypt(Wire.plaintext(), key: Wire.key)
        let bytes = try XCTUnwrap(Data(base64Encoded: sealed["ciphertext"].string))
        XCTAssertEqual(bytes.first, 0); XCTAssertGreaterThan(bytes.count, 29)
        XCTAssertEqual(sealed["encryption_variant"].string, "data_key_v1")
    }

    func testOptionalReportFieldsMayBeAbsent() throws {
        let plain = JSON.object(["version": .number(1), "report_id": .string("rpt_1"), "session_id": .string("session-1"), "notification_id": .string("N-9"), "title": .string("Soak"),
                                 "summary": .string("Done"), "body": .string("Body"), "importance": .string("normal"), "created_at": .string("2026-11-04T08:00:00Z")])
        let report = try NotificationReport.open(try Wire.report(plaintext: plain), reportID: "rpt_1", session: Wire.session())
        XCTAssertNil(report.bot); XCTAssertNil(report.threadID); XCTAssertNil(report.record.target)
    }

    func testTheRelayCannotSwapAReport() throws {
        // The envelope is genuine, but it was sealed for another report.
        let swapped = try Wire.report("rpt_1", plaintext: Wire.plaintext("rpt_2"))
        XCTAssertThrowsError(try NotificationReport.open(swapped, reportID: "rpt_1", session: Wire.session())) { XCTAssertEqual($0 as? NotificationReportError, .mismatch) }
        // Nor can it serve one from another session, or answer with another id.
        let foreign = try Wire.report("rpt_1", plaintext: Wire.plaintext("rpt_1", session: "session-2"))
        XCTAssertThrowsError(try NotificationReport.open(foreign, reportID: "rpt_1", session: Wire.session())) { XCTAssertEqual($0 as? NotificationReportError, .mismatch) }
        XCTAssertThrowsError(try NotificationReport.open(try Wire.report("rpt_2"), reportID: "rpt_1", session: Wire.session())) { XCTAssertEqual($0 as? NotificationReportError, .mismatch) }
    }

    func testAnUnknownReportVersionIsRefused() throws {
        let future = try Wire.report(plaintext: Wire.plaintext(version: 2))
        XCTAssertThrowsError(try NotificationReport.open(future, reportID: "rpt_1", session: Wire.session())) { XCTAssertEqual($0 as? NotificationReportError, .unsupportedVersion) }
    }

    func testARotatedKeyIsADecryptFailure() throws {
        let old = try Wire.report(key: Data(repeating: 1, count: 32))
        XCTAssertThrowsError(try NotificationReport.open(old, reportID: "rpt_1", session: Wire.session())) { XCTAssertEqual($0 as? NotificationReportError, .undecryptable) }
        XCTAssertThrowsError(try NotificationReport.open(try Wire.report(), reportID: "rpt_1", session: Wire.session(key: nil))) { XCTAssertEqual($0 as? NotificationReportError, .undecryptable) }
    }

    func testAnIncompleteReportIsRefused() throws {
        let empty = try Wire.report(plaintext: Wire.plaintext().setting("notification_id", .string("")))
        XCTAssertThrowsError(try NotificationReport.open(empty, reportID: "rpt_1", session: Wire.session())) { XCTAssertEqual($0 as? NotificationReportError, .malformed) }
    }

    func testReportIDsCannotEscapeTheURLPath() {
        XCTAssertTrue(NotificationReportClient.isValid(id: "rpt_0f3a-9"))
        for bad in ["", "../devices", "a/b", "rpt 1", "rpt%2f", String(repeating: "a", count: 129), "répt"] { XCTAssertFalse(NotificationReportClient.isValid(id: bad), bad) }
    }

    func testRequestsCarryTheClientToken() async throws {
        let http = CentreHTTP()
        await http.put("rpt_1", try Wire.report())
        let client = NotificationReportClient(http: http)
        let session = Wire.session()
        _ = try await client.list(session: session)
        _ = try await client.fetch("rpt_1", session: session)
        let paths = await http.paths, tokens = await http.authorization
        XCTAssertEqual(paths, ["/v1/sessions/session-1/reports", "/v1/sessions/session-1/reports/rpt_1"])
        XCTAssertEqual(tokens, ["Bearer client-token", "Bearer client-token"])
    }

    func testAbsentCapabilityMeansNoReportCallsAtAll() async throws {
        for (body, status) in [(#"{"apns":[]}"#, 200), ("{}", 404), (#"{"apns":[],"reports":{}}"#, 200)] {
            let rig = Rig(connected: false)
            await rig.http.set(capability: body, status: status)
            await rig.http.put("rpt_1", try Wire.report())
            await rig.store.refresh(model: rig.model, immediate: true)
            let detail = await rig.store.detail(for: NotificationDetailTarget(notificationID: "N-9", reportID: "rpt_1"), model: rig.model)
            XCTAssertTrue(rig.store.reportRecords.isEmpty)
            XCTAssertTrue(detail.onComputer, "Falls back to the honest state")
            let reportCalls = await rig.http.reportCalls()
            XCTAssertEqual(reportCalls, [], "An old relay sees no report traffic: \(body)")
        }
    }

    func testAFailedCapabilityCheckMakesNoReportCallsAndIsAskedAgain() async throws {
        let http = CentreHTTP()
        await http.set(capability: "oops", status: 503)
        let client = NotificationReportClient(http: http)
        let first = await client.capability(Wire.session())
        XCTAssertNil(first)
        await http.set(capability: #"{"reports":{"max_bytes":262144,"max_ttl_seconds":2592000}}"#)
        let second = await client.capability(Wire.session())
        XCTAssertEqual(second?.maxBytes, 262144); XCTAssertEqual(second?.maxTTLSeconds, 2592000)
        _ = await client.capability(Wire.session())
        let asks = await http.paths.count
        XCTAssertEqual(asks, 2, "A good answer is remembered")
    }

    // MARK: The computer is asleep

    func testOfflineListIsWhatWasLoadedPlusHostedNotices() async throws {
        let rig = Rig { _, _ in Wire.list([Wire.record(5, id: "N-5", day: "2026-11-05"), Wire.record(9, id: "N-9", kind: "agent_notice", day: "2026-11-01")], unread: 2) }
        await rig.store.refresh(model: rig.model)
        rig.model.connected = false
        await rig.http.put("rpt_1", try Wire.report("rpt_1", plaintext: Wire.plaintext("rpt_1", notification: "N-9")))
        await rig.http.put("rpt_2", try Wire.report("rpt_2", plaintext: Wire.plaintext("rpt_2", notification: "N-20")))
        await rig.store.refresh(model: rig.model, immediate: true)
        XCTAssertEqual(rows(rig.store, offline: true), ["N-5", "N-20", "N-9"], "The daemon's row wins; hosted ones fill the gaps, by time")
        XCTAssertEqual(rows(rig.store, offline: false), ["N-5", "N-9"], "Connected shows only the daemon's records")
        XCTAssertEqual(rig.store.unreadCount(offline: true), 3); XCTAssertEqual(rig.store.unreadCount(offline: false), 2)
        rig.store.setFilter(.needsYou)
        XCTAssertEqual(rows(rig.store, offline: true), [], "Filters apply to offline rows too")
    }

    func testReportsOpenWithBoundedConcurrencyAndOnlyOnce() async throws {
        let rig = Rig(connected: false)
        for index in 0..<12 { await rig.http.put("rpt_\(index)", try Wire.report("rpt_\(index)", plaintext: Wire.plaintext("rpt_\(index)", notification: "N-\(index)"))) }
        await rig.store.refresh(model: rig.model, immediate: true)
        XCTAssertEqual(rig.store.reportRecords.count, 12)
        let peak = await rig.http.mostInFlight
        XCTAssertLessThanOrEqual(peak, 4)
        XCTAssertGreaterThan(peak, 1)
        let before = await rig.http.reportCalls().count
        await rig.store.refresh(model: rig.model, immediate: true)
        let after = await rig.http.reportCalls().count
        XCTAssertEqual(after, before + 1, "Only the list again; decrypted reports stay in memory")
    }

    func testOneBadReportHidesNothingElse() async throws {
        let rig = Rig(connected: false)
        await rig.http.put("rpt_good", try Wire.report("rpt_good", plaintext: Wire.plaintext("rpt_good", notification: "N-1")))
        await rig.http.put("rpt_swap", try Wire.report("rpt_swap", plaintext: Wire.plaintext("rpt_good", notification: "N-1")))
        await rig.http.put("rpt_old", try Wire.report("rpt_old", plaintext: Wire.plaintext("rpt_old", notification: "N-2"), key: Data(repeating: 1, count: 32)))
        await rig.store.refresh(model: rig.model, immediate: true)
        XCTAssertEqual(rig.store.reportRecords.map(\.id), ["N-1"])
        await rig.store.refresh(model: rig.model, immediate: true)
        let calls = await rig.http.reportCalls().filter { $0.hasSuffix("rpt_old") }.count
        XCTAssertEqual(calls, 1, "A report this key cannot open is not fetched again")
    }

    func testAPassingDisconnectCostsNoRelayRequests() async throws {
        let defaults = UserDefaults(suiteName: "NotificationSettle-\(UUID())")!
        let http = CentreHTTP()
        let store = NotificationCentreStore(defaults: defaults, reportClient: NotificationReportClient(http: http), offlineSettle: .milliseconds(150))
        let session = Wire.session()
        let model = AppModel.testing(relay: CentreRelay { _, _ in Wire.list([]) }, sessionLoader: { session }, notificationCentre: store)
        model.hasSession = true; model.connected = false
        let waiting = Task { await store.refresh(model: model) }
        model.connected = true
        await waiting.value
        let calls = await http.paths
        XCTAssertEqual(calls, [])
    }

    func testAnOfflineNoticeOpensWithoutTheDaemon() async throws {
        let rig = Rig(connected: false)
        await rig.http.put("rpt_1", try Wire.report())
        let detail = await rig.store.detail(for: NotificationDetailTarget(notificationID: "N-9", reportID: "rpt_1"), model: rig.model)
        XCTAssertEqual(detail.body, "**All clear.**"); XCTAssertTrue(detail.fromRelay); XCTAssertFalse(detail.onComputer)
        XCTAssertEqual(detail.record?.title, "Soak finished")
        let daemonCalls = await rig.relay.calls.count
        XCTAssertEqual(daemonCalls, 0)
        await rig.store.markRead("N-9", model: rig.model)
        let again = await rig.store.detail(for: NotificationDetailTarget(notificationID: "N-9", reportID: "rpt_1"), model: rig.model)
        XCTAssertEqual(again.record?.isRead, true)
        let fetched = await rig.http.reportCalls().count
        XCTAssertEqual(fetched, 1, "The opened report stays in memory")
    }

    func testAPushCannotPairARecordWithAnotherReport() async throws {
        let rig = Rig(connected: false)
        await rig.http.put("rpt_1", try Wire.report())
        let detail = await rig.store.detail(for: NotificationDetailTarget(notificationID: "N-500", reportID: "rpt_1"), model: rig.model)
        XCTAssertTrue(detail.onComputer); XCTAssertNil(detail.body)
    }

    func testTheDaemonsCopyIsPreferredWhenConnected() async throws {
        let rig = Rig { method, params in
            XCTAssertEqual(method, "notification.get"); XCTAssertEqual(params["id"].string, "N-9")
            return Wire.record(9, kind: "agent_notice", extra: ["has_body": .bool(true), "body": .string("Daemon body")])
        }
        await rig.http.put("rpt_1", try Wire.report())
        let detail = await rig.store.detail(for: NotificationDetailTarget(notificationID: "N-9", reportID: "rpt_1"), model: rig.model)
        XCTAssertEqual(detail.body, "Daemon body"); XCTAssertFalse(detail.fromRelay)
        let calls = await rig.http.paths
        XCTAssertEqual(calls, [], "No relay traffic while the daemon answers")
    }

    func testADaemonFailureFallsBackToTheRelay() async throws {
        let rig = Rig { _, _ in throw PilotError("Timed out") }
        await rig.http.put("rpt_1", try Wire.report())
        let detail = await rig.store.detail(for: NotificationDetailTarget(notificationID: "N-9", reportID: "rpt_1"), model: rig.model)
        XCTAssertEqual(detail.body, "**All clear.**"); XCTAssertTrue(detail.fromRelay)
    }

    func testARotatedKeyFallsBackToTheDaemonThenSaysWhereTheReportIs() async throws {
        let rig = Rig(connected: false)
        await rig.http.put("rpt_1", try Wire.report(key: Data(repeating: 1, count: 32)))
        let target = NotificationDetailTarget(notificationID: "N-9", reportID: "rpt_1")
        let offline = await rig.store.detail(for: target, model: rig.model)
        XCTAssertTrue(offline.onComputer); XCTAssertNil(offline.body)
        rig.model.connected = true
        await rig.relay.replace { _, _ in Wire.record(9, kind: "agent_notice", extra: ["has_body": .bool(true), "body": .string("From the daemon")]) }
        let connected = await rig.store.detail(for: target, model: rig.model)
        XCTAssertEqual(connected.body, "From the daemon"); XCTAssertFalse(connected.onComputer)
    }

    func testAnExpiredReportSaysWhereItIs() async throws {
        let rig = Rig(connected: false)
        let detail = await rig.store.detail(for: NotificationDetailTarget(notificationID: "N-9", reportID: "rpt_gone"), model: rig.model)
        XCTAssertTrue(detail.onComputer)
    }

    func testANoticeWithoutABodyIsNotPretendedToBeAReport() async throws {
        let rig = Rig { _, _ in Wire.list([Wire.record(3, kind: "agent_notice")]) }
        await rig.store.refresh(model: rig.model)
        rig.model.connected = false
        let detail = await rig.store.detail(for: NotificationDetailTarget(notificationID: "N-3"), model: rig.model)
        XCTAssertFalse(detail.onComputer); XCTAssertNil(detail.body); XCTAssertEqual(detail.record?.preview, "Preview 3")
    }

    // MARK: The offline read queue

    func testAnOfflineReadIsKeptAndReplayedOnReconnect() async throws {
        let rig = Rig { method, _ in method == "notifications.mark_read" ? Wire.counts(unread: 0, latest: 3) : Wire.list([Wire.record(3)], unread: 1, latest: 3) }
        await rig.store.refresh(model: rig.model)
        rig.model.receive(.init(connectionID: rig.model.connectionID, event: .status("Computer offline", connected: false)))
        await rig.store.markRead("N-3", model: rig.model)
        await rig.store.markRead("N-3", model: rig.model)
        XCTAssertEqual(rig.store.record("N-3")?.isRead, true); XCTAssertEqual(rig.store.counts.unread, 0)
        XCTAssertEqual(rig.store.offlineReads, ["N-3"])
        var sent = await rig.relay.count("notifications.mark_read")
        XCTAssertEqual(sent, 0)
        rig.model.receive(.init(connectionID: rig.model.connectionID, event: .status("Connected", connected: true)))
        await settle { rig.store.offlineReads.isEmpty }
        sent = await rig.relay.count("notifications.mark_read")
        XCTAssertEqual(sent, 1)
        let body = await rig.relay.last("notifications.mark_read")
        XCTAssertEqual(body, .object(["ids": .array([.string("N-3")])]))
    }

    func testAReadTheConnectionLostIsKeptRatherThanRolledBack() async throws {
        let rig = Rig { method, _ in
            if method == "notifications.mark_read" { throw PilotError("The connection closed.") }
            return Wire.list([Wire.record(3)], unread: 1, latest: 3)
        }
        await rig.store.refresh(model: rig.model)
        await rig.relay.gate("notifications.mark_read")
        let read = Task { await rig.store.markRead("N-3", model: rig.model) }
        await settle { await rig.relay.holding() }
        rig.model.connected = false
        await rig.relay.release(); await read.value
        XCTAssertEqual(rig.store.record("N-3")?.isRead, true)
        XCTAssertEqual(rig.store.offlineReads, ["N-3"])
    }

    func testQueuedReadsSurviveARelaunchAndOverlayTheFirstList() async throws {
        let rig = Rig(connected: false)
        await rig.store.markRead("N-3", model: rig.model)
        let (store, model) = rig.relaunched(connected: true)
        await rig.relay.replace { method, _ in
            if method == "notifications.mark_read" { throw PilotError("Busy") }
            return Wire.list([Wire.record(3)], unread: 1, latest: 3)
        }
        await store.refresh(model: model)
        XCTAssertEqual(store.record("N-3")?.isRead, true, "The daemon has not heard yet; the row stays read")
        XCTAssertEqual(store.counts.unread, 0)
        await store.replayOfflineReads(model: model)
        XCTAssertEqual(store.offlineReads, ["N-3"], "A failed replay keeps them")
        await rig.relay.replace { method, _ in method == "notifications.mark_read" ? Wire.counts(unread: 0) : Wire.list([Wire.record(3, read: true)], unread: 0) }
        await store.replayOfflineReads(model: model)
        XCTAssertTrue(store.offlineReads.isEmpty)
        let last = rig.relaunched(connected: true)
        await last.store.replayOfflineReads(model: last.model)
        XCTAssertTrue(last.store.offlineReads.isEmpty, "Replayed reads are gone from disk too")
    }

    func testForgettingAComputerClearsItsQueuedReads() async throws {
        let rig = Rig(connected: false)
        await rig.store.markRead("N-3", model: rig.model)
        XCTAssertFalse(rig.defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix("native.notifications.offlineReads.") }.isEmpty)
        rig.store.reset(clearData: true, forgotten: true)
        XCTAssertTrue(rig.store.offlineReads.isEmpty)
        XCTAssertTrue(rig.defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix("native.notifications.offlineReads.") }.isEmpty)
    }

    func testAnotherPairingsQueueIsNotReplayedHere() async throws {
        let rig = Rig(connected: false)
        let queue = NotificationOfflineReads(defaults: rig.defaults)
        queue.save(["N-1"], sessionID: "session-old")
        await rig.store.refresh(model: rig.model, immediate: true)
        XCTAssertTrue(rig.store.offlineReads.isEmpty)
        XCTAssertTrue(queue.load(sessionID: "session-old").isEmpty, "Left behind by a re-pair, so dropped")
    }

    // MARK: Offline preview

    func testTheLastListSurvivesInTheEncryptedPreview() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "NotificationPreview-\(UUID())", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let rig = Rig { method, _ in method == "notifications.mark_read" ? Wire.counts(unread: 1) : Wire.list([Wire.record(3), Wire.record(2)], next: 2, unread: 2, needsYou: 1, latest: 3) }
        await rig.store.refresh(model: rig.model)
        await rig.store.markRead("N-3", model: rig.model)
        let snapshot = try XCTUnwrap(rig.store.previewSnapshot)
        let cache = try SessionCacheStore(session: Wire.session(), root: root)
        try await cache.save(SessionCacheInput(projects: [], tasks: [], preferences: .object([:]), selectedID: nil, histories: [:], notifications: snapshot))
        // A save before the list has loaded must not wipe the copy.
        try await cache.save(SessionCacheInput(projects: [], tasks: [], preferences: .object(["x": .bool(true)]), selectedID: nil, histories: [:]))
        let reopened = try SessionCacheStore(session: Wire.session(), root: root)
        let restored = await reopened.load()
        let (store, model) = rig.relaunched(connected: false)
        store.restorePreview(restored?.notifications)
        XCTAssertEqual(rows(store, offline: true), ["N-3", "N-2"])
        XCTAssertEqual(store.record("N-3")?.isRead, true, "The copy holds the read too")
        XCTAssertEqual(store.counts.unread, 1); XCTAssertFalse(store.loaded)
        model.connected = true
        await rig.relay.replace { _, _ in Wire.list([Wire.record(9), Wire.record(8)], next: 8, unread: 5, latest: 9) }
        await store.refresh(model: model)
        XCTAssertEqual(rows(store), ["N-9", "N-8"], "The daemon replaces a preview outright")
        XCTAssertEqual(store.pages[.all]?.nextBeforeSeq, 8)
    }

    // MARK: Routing

    func testAnOldPushIsExactlyWhatItWas() throws {
        let destination = try XCTUnwrap(NotificationDestination(userInfo: ["sessionId": "s", "workspaceId": "w", "threadId": "t"]))
        XCTAssertEqual(destination.sessionID, "s"); XCTAssertEqual(destination.workspaceID, "w"); XCTAssertEqual(destination.threadID, "t")
        XCTAssertNil(destination.notificationID); XCTAssertNil(destination.reportID); XCTAssertNil(destination.detailTarget)
        XCTAssertEqual(destination.userInfo, ["sessionId": "s", "workspaceId": "w", "threadId": "t"])
        for broken: [AnyHashable: Any] in [["sessionId": "s", "workspaceId": "w"], ["sessionId": "s", "threadId": "t"], ["workspaceId": "w", "threadId": "t"],
                                           ["sessionId": "", "workspaceId": "w", "threadId": "t"], ["sessionId": "s", "workspaceId": "w", "threadId": ""],
                                           ["sessionId": "s", "workspaceId": "w", "threadId": "a\nb"], ["sessionId": "s", "workspaceId": "w", "threadId": String(repeating: "x", count: 1025)],
                                           ["sessionId": "s", "kind": "agent-notice"]] {
            XCTAssertNil(NotificationDestination(userInfo: broken), "\(broken)")
        }
    }

    func testAPushWithAThreadAndARecordStillGoesToTheThread() throws {
        let destination = try XCTUnwrap(NotificationDestination(userInfo: ["sessionId": "s", "workspaceId": "w", "threadId": "t", "kind": "turn-complete", "notificationId": "N-4"]))
        XCTAssertEqual(destination.threadID, "t"); XCTAssertEqual(destination.notificationID, "N-4"); XCTAssertNil(destination.detailTarget)
    }

    func testANoticeNeedsNoThread() throws {
        let absent = try XCTUnwrap(NotificationDestination(userInfo: ["sessionId": "s", "kind": "agent-notice", "notificationId": "N-4", "reportId": "rpt_1"]))
        XCTAssertEqual(absent.detailTarget, NotificationDetailTarget(notificationID: "N-4", reportID: "rpt_1"))
        XCTAssertEqual(absent.threadID, "")
        // APNs JSON carries null for a notice without a thread.
        let null = try XCTUnwrap(NotificationDestination(userInfo: ["sessionId": "s", "workspaceId": NSNull(), "threadId": NSNull(), "kind": "agent-notice", "notificationId": "N-4"]))
        XCTAssertEqual(null.detailTarget, NotificationDetailTarget(notificationID: "N-4"))
        let empty = try XCTUnwrap(NotificationDestination(userInfo: ["sessionId": "s", "workspaceId": "", "threadId": "", "kind": "agent-notice", "notificationId": "N-4"]))
        XCTAssertNotNil(empty.detailTarget)
        let reportOnly = try XCTUnwrap(NotificationDestination(userInfo: ["sessionId": "s", "kind": "agent-notice", "reportId": "rpt_1"]))
        XCTAssertEqual(reportOnly.detailTarget?.reportID, "rpt_1")
    }

    func testANoticeWithAThreadOpensItsReportNotTheThread() throws {
        let destination = try XCTUnwrap(NotificationDestination(userInfo: ["sessionId": "s", "workspaceId": "w", "threadId": "t", "kind": "agent-notice", "notificationId": "N-4", "reportId": "rpt_1"]))
        XCTAssertEqual(destination.detailTarget?.notificationID, "N-4"); XCTAssertEqual(destination.threadID, "t")
        let round = try XCTUnwrap(NotificationDestination(userInfo: destination.userInfo))
        XCTAssertEqual(round, destination)
    }

    func testABadReportIdNeverReachesARequest() throws {
        let destination = try XCTUnwrap(NotificationDestination(userInfo: ["sessionId": "s", "workspaceId": "w", "threadId": "t", "reportId": "../devices"]))
        XCTAssertNil(destination.reportID); XCTAssertNil(destination.detailTarget)
        XCTAssertNil(NotificationDestination(userInfo: ["sessionId": "s", "reportId": "../devices"]))
    }

    func testTappingANoticeWithTheMacAsleepOpensItAndKeepsTheRead() async throws {
        let rig = Rig(connected: false)
        rig.model.pendingNotification = NotificationDestination(userInfo: ["sessionId": "session-1", "kind": "agent-notice", "notificationId": "N-9", "reportId": "rpt_1"])
        await rig.model.openPendingNotification()
        XCTAssertNil(rig.model.pendingNotification)
        XCTAssertEqual(rig.model.selection, .notifications)
        XCTAssertEqual(rig.store.openRequest, NotificationDetailTarget(notificationID: "N-9", reportID: "rpt_1"))
        await settle { rig.store.offlineReads == ["N-9"] }
    }

    func testTappingANoticeWhileLookingAtTheListOpensItThere() async throws {
        let rig = Rig(connected: false)
        rig.model.selection = .notifications
        let request = rig.model.detailRequestID
        rig.model.pendingNotification = NotificationDestination(userInfo: ["sessionId": "session-1", "kind": "agent-notice", "notificationId": "N-9"])
        await rig.model.openPendingNotification()
        XCTAssertNotEqual(rig.model.detailRequestID, request, "An unchanged selection still reveals the detail column")
        XCTAssertNotNil(rig.store.openRequest)
    }

    func testANoticeOpenedAtLaunchIsNotReplacedByTheRestoredSelection() async throws {
        let rig = Rig(connected: false)
        rig.model.restoringSession = true
        rig.model.pendingNotification = NotificationDestination(userInfo: ["sessionId": "session-1", "kind": "agent-notice", "notificationId": "N-9"])
        await rig.model.openPendingNotification()
        XCTAssertNotNil(rig.model.pendingNotification, "Waits for navigation to be restored")
        rig.model.restoringSession = false
        rig.model.pendingSelection = .task("elsewhere")
        await rig.model.openPendingNotification()
        XCTAssertEqual(rig.model.selection, .notifications)
        XCTAssertNil(rig.model.pendingSelection)
    }

    func testTappingAnOrdinaryPushMarksItsRecordAndOpensTheThread() async throws {
        let rig = Rig { _, _ in Wire.counts(unread: 0) }
        rig.model.pendingNotification = NotificationDestination(userInfo: ["sessionId": "session-1", "workspaceId": "w", "threadId": "t", "kind": "review", "notificationId": "N-7"])
        await rig.model.openPendingNotification()
        XCTAssertEqual(rig.model.selection, .task("t"))
        await settle { await rig.relay.count("notifications.mark_read") == 1 }
        let sent = await rig.relay.last("notifications.mark_read")
        XCTAssertEqual(sent, .object(["ids": .array([.string("N-7")])]))
    }

    func testAnOldPushMarksNothing() async throws {
        let rig = Rig()
        rig.model.pendingNotification = NotificationDestination(userInfo: ["sessionId": "session-1", "workspaceId": "w", "threadId": "t"])
        await rig.model.openPendingNotification()
        XCTAssertEqual(rig.model.selection, .task("t"))
        try await Task.sleep(for: .milliseconds(30))
        let calls = await rig.relay.calls.count
        XCTAssertEqual(calls, 0)
    }

    func testAnOldPushStillWaitsForTheComputer() async throws {
        let rig = Rig(connected: false)
        let destination = NotificationDestination(userInfo: ["sessionId": "session-1", "workspaceId": "w", "threadId": "t"])
        rig.model.pendingNotification = destination
        await rig.model.openPendingNotification()
        XCTAssertEqual(rig.model.pendingNotification, destination)
        XCTAssertNil(rig.model.error)
    }

    func testAThreadPushWhileOfflineKeepsTheReadAndWaitsForTheComputer() async throws {
        let rig = Rig(connected: false)
        let destination = NotificationDestination(userInfo: ["sessionId": "session-1", "workspaceId": "w", "threadId": "t", "notificationId": "N-7"])
        rig.model.pendingNotification = destination
        await rig.model.openPendingNotification()
        XCTAssertEqual(rig.model.pendingNotification, destination, "Waits for the thread as before")
        await settle { rig.store.offlineReads == ["N-7"] }
    }

    func testAnotherComputersPushMarksNothingAndSaysSo() async throws {
        let rig = Rig(connected: false)
        rig.model.pendingNotification = NotificationDestination(userInfo: ["sessionId": "other", "kind": "agent-notice", "notificationId": "N-9"])
        await rig.model.openPendingNotification()
        XCTAssertNil(rig.model.pendingNotification); XCTAssertNotNil(rig.model.error); XCTAssertNil(rig.store.openRequest)
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(rig.store.offlineReads.isEmpty)
    }

    func testANoticeBannerShowsEvenWhenItsThreadIsOpen() throws {
        let rig = Rig()
        rig.model.selection = .task("t")
        let notice = try XCTUnwrap(NotificationDestination(userInfo: ["sessionId": "session-1", "workspaceId": "w", "threadId": "t", "kind": "agent-notice", "notificationId": "N-9"]))
        let ordinary = try XCTUnwrap(NotificationDestination(userInfo: ["sessionId": "session-1", "workspaceId": "w", "threadId": "t"]))
        XCTAssertEqual(rig.model.notifications.shouldPresent?(notice), true)
        XCTAssertEqual(rig.model.notifications.shouldPresent?(ordinary), false)
    }

    // MARK: Replies

    func testAReplyGoesToTheThreadThroughTheComposersPath() async throws {
        let rig = Rig { method, _ in method == "turn.start" ? .object(["message": .string("accepted")]) : .object([:]) }
        try await rig.model.sendNotificationReply("Ship the upload change", workspaceID: "w", threadID: "t")
        let last = await rig.relay.last("turn.start")
        let sent = try XCTUnwrap(last)
        XCTAssertEqual(sent["workspace_id"].string, "w"); XCTAssertEqual(sent["thread_id"].string, "t")
        XCTAssertEqual(sent["inputs"].array.first?["text"].string, "Ship the upload change")
        XCTAssertEqual(rig.model.selection, .projects, "Replying does not leave the report")
    }

    func testAReplyThatFailsKeepsTheWordsAndSaysSo() async throws {
        let rig = Rig { method, _ in
            if method == "turn.start" { throw PilotError("The computer took too long to respond.") }
            return .object([:])
        }
        do {
            try await rig.model.sendNotificationReply("Keep me", workspaceID: "w", threadID: "t")
            XCTFail("A failed send must throw")
        } catch { XCTAssertTrue(error.localizedDescription.contains("too long"), error.localizedDescription) }
    }

    func testAReplyNeedsTheComputer() async throws {
        let rig = Rig(connected: false)
        do {
            try await rig.model.sendNotificationReply("Hello", workspaceID: "w", threadID: "t")
            XCTFail("Offline must throw")
        } catch { }
        let calls = await rig.relay.calls.count
        XCTAssertEqual(calls, 0)
    }

    func testADictatedReplySurvivesARelaunchUntilForgotten() async throws {
        let rig = Rig()
        rig.store.editReply("N-9", text: "Do the upload change", model: rig.model)
        let saved = await rig.store.persistReply("N-9", model: rig.model)
        XCTAssertTrue(saved)
        let (store, model) = rig.relaunched(connected: true)
        await store.restoreReplies(model: model)
        XCTAssertEqual(store.reply("N-9"), "Do the upload change")
        store.editReply("N-9", text: "", model: model)
        _ = await store.persistReply("N-9", model: model)
        let cleared = rig.relaunched(connected: true)
        await cleared.store.restoreReplies(model: cleared.model)
        XCTAssertEqual(cleared.store.reply("N-9"), "", "A sent reply clears itself")
    }
}
