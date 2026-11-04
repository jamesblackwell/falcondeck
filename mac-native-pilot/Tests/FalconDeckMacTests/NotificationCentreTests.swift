import Foundation
import XCTest
@testable import FalconDeckMac

private func stamp(_ date: Date) -> JSON { .string(date.formatted(Date.ISO8601FormatStyle())) }

private func row(_ seq: Int, kind: String = "turn_complete", read: Bool = false, resolved: Bool = false,
                 bot: String? = nil, body: Bool = false, target: JSON? = nil, at: Date = Date()) -> JSON {
    var fields: [String: JSON] = ["id": .string("N-\(seq)"), "seq": .number(Double(seq)), "kind": .string(kind),
        "title": .string("Row \(seq)"), "preview": .string("Preview \(seq)"), "created_at": stamp(at),
        "importance": .string("normal"), "has_body": .bool(body), "repeat_count": .number(0)]
    if read { fields["read_at"] = stamp(at) }
    if resolved { fields["resolved_at"] = stamp(at) }
    if let bot { fields["bot"] = .string(bot) }
    if let target { fields["target"] = target }
    return .object(fields)
}

/// Behaves like the daemon's store: newest first, seq paging, store-wide counts.
@MainActor private final class FakeNotifications {
    struct Call { let path: [String]; let method: String; let query: [URLQueryItem]; let body: JSON?; let host: String? }
    var rows: [JSON]
    var calls: [Call] = []
    var failure: Error?
    var failReads: Error?
    var failOlderPages: Error?
    var holdLists = false
    var holdOlderPages = false
    var holdReads = false
    private var held: [CheckedContinuation<Void, Never>] = []

    init(_ rows: [JSON] = []) { self.rows = rows }
    var heldCount: Int { held.count }
    func release() { let waiting = held; held = []; waiting.forEach { $0.resume() } }
    var lists: [Call] { calls.filter { $0.path == ["api", "notifications"] } }
    var reads: [Call] { calls.filter { $0.path == ["api", "notifications", "read"] } }

    private func matches(_ value: JSON, _ filter: String?) -> Bool {
        guard let filter, let parsed = NotificationFilter(rawValue: filter) else { return true }
        return NotificationRecord(value).matches(parsed)
    }

    private var counts: [String: JSON] {
        ["unread_count": .number(Double(rows.filter { !NotificationRecord($0).isRead }.count)),
         "needs_you_count": .number(Double(rows.filter { NotificationRecord($0).matches(.needsYou) }.count)),
         "latest_seq": .number(Double(rows.map { $0["seq"].int }.max() ?? 0))]
    }

    func transport(_ path: [String], _ method: String, _ query: [URLQueryItem], _ body: JSON?, _ host: String?) async throws -> JSON {
        calls.append(.init(path: path, method: method, query: query, body: body, host: host))
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
        if path == ["api", "notifications", "read"] {
            if holdReads { await withCheckedContinuation { held.append($0) } }
            if let failReads { throw failReads }
            let ids = Set(body?["ids"].array.map(\.string) ?? [])
            let upTo = body?["up_to_seq"].optionalInt ?? -1
            rows = rows.map { ids.contains($0["id"].string) || $0["seq"].int <= upTo ? $0.setting("read_at", stamp(Date())) : $0 }
            return .object(counts)
        }
        if path.count == 3 { return rows.first { $0["id"].string == path[2] } ?? .null }
        // The snapshot is taken on arrival, as the daemon answers before the reply crosses back.
        let before = value("before_seq").flatMap(Int.init), limit = value("limit").flatMap(Int.init) ?? 50
        let matching = rows.sorted { $0["seq"].int > $1["seq"].int }
            .filter { before == nil || $0["seq"].int < before! }.filter { matches($0, value("filter")) }
        let page = Array(matching.prefix(limit))
        var response = counts
        response["items"] = .array(page)
        if matching.count > page.count { response["next_before_seq"] = page.last?["seq"] }
        if let failure { throw failure }
        if before != nil, let failOlderPages { throw failOlderPages }
        if holdLists || (holdOlderPages && before != nil) { await withCheckedContinuation { held.append($0) } }
        return .object(response)
    }
}

@MainActor private func eventually(_ what: String, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async {
    for _ in 0..<400 {
        if condition() { return }
        try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("Timed out waiting for \(what)", file: file, line: line)
}

private func controlEvent(_ domains: String...) -> JSON {
    .object(["type": .string("control-state-changed"),
             "change": .object(["store_revision": .number(1), "domains": .array(domains.map(JSON.string))])])
}

@MainActor private func centre(_ daemon: FakeNotifications, debounce: Duration = .milliseconds(1)) -> NotificationCentreStore {
    NotificationCentreStore(transport: { try await daemon.transport($0, $1, $2, $3, $4) }, debounce: debounce)
}

@MainActor final class NotificationCentreTests: XCTestCase {
    // MARK: Paging

    func testPagesFollowNextBeforeSeqUntilTheDaemonStopsOffering() async throws {
        let daemon = FakeNotifications((1...120).map { row($0) })
        let store = centre(daemon)
        await store.refresh()
        XCTAssertEqual(store.records.count, 50)
        XCTAssertEqual(store.records.first?.id, "N-120")
        XCTAssertEqual(store.nextBeforeSeq, 71)

        await store.loadMore()
        XCTAssertEqual(store.records.count, 100)
        XCTAssertEqual(daemon.lists.last?.query.first { $0.name == "before_seq" }?.value, "71")

        await store.loadMore()
        XCTAssertEqual(store.records.count, 120)
        XCTAssertEqual(store.records.last?.id, "N-1")
        XCTAssertNil(store.nextBeforeSeq)
        let calls = daemon.lists.count
        await store.loadMore()
        XCTAssertEqual(daemon.lists.count, calls, "The last page must not be requested again")
    }

    func testARefetchRereadsTheLoadedRowsAndOlderOnesComeBackOnScroll() async {
        let daemon = FakeNotifications((1...120).map { row($0) })
        let store = centre(daemon)
        await store.refresh()
        await store.loadMore()
        daemon.rows.append(row(121))
        await store.refresh()
        XCTAssertEqual(store.records.first?.id, "N-121")
        XCTAssertEqual(store.records.count, 100)
        XCTAssertEqual(store.nextBeforeSeq, 22)
        await store.loadMore()
        XCTAssertEqual(store.records.count, 121)
        XCTAssertEqual(Set(store.records.map(\.id)).count, 121, "No row repeats across the seam")
    }

    func testARefetchAfterABurstLeavesNoGapBehindTheCursor() async {
        let daemon = FakeNotifications((1...100).map { row($0) })
        let store = centre(daemon)
        await store.refresh()
        XCTAssertEqual(store.nextBeforeSeq, 51)
        daemon.rows += (101...200).map { row($0) }

        await store.refresh()
        XCTAssertEqual(store.records.map(\.seq), Array((151...200).reversed()))
        XCTAssertEqual(store.nextBeforeSeq, 151)

        await store.loadMore()
        await store.loadMore()
        await store.loadMore()
        XCTAssertEqual(store.records.map(\.seq), Array((1...200).reversed()), "Every record is reachable, once")
        XCTAssertNil(store.nextBeforeSeq)
    }

    func testARefetchWalksPastTheMaximumPageSoEveryLoadedRowIsFresh() async {
        let daemon = FakeNotifications((1...300).map { row($0) })
        let store = centre(daemon)
        await store.refresh()
        for _ in 0..<4 { await store.loadMore() }
        XCTAssertEqual(store.records.count, 250)
        XCTAssertEqual(store.nextBeforeSeq, 51)

        // Read on another device, including rows past the first 200.
        daemon.rows = daemon.rows.map { $0.setting("read_at", stamp(Date())) }
        let calls = daemon.lists.count
        await store.refresh()

        XCTAssertEqual(store.records.count, 250)
        XCTAssertTrue(store.records.allSatisfy(\.isRead))
        XCTAssertEqual(store.records.map(\.seq), Array((51...300).reversed()))
        XCTAssertEqual(store.nextBeforeSeq, 51, "The cursor comes from the last page")
        func values(_ name: String) -> [String?] {
            daemon.lists[calls...].map { call in call.query.first { $0.name == name }?.value }
        }
        XCTAssertEqual(values("limit"), ["200", "50"])
        XCTAssertEqual(values("before_seq"), [nil, "101"])
    }

    func testAWalkThatFailsPartWayChangesNothing() async {
        let daemon = FakeNotifications((1...300).map { row($0) })
        let store = centre(daemon)
        await store.refresh()
        for _ in 0..<4 { await store.loadMore() }
        let shown = store.records.map(\.id), cursor = store.nextBeforeSeq, unread = store.counts.unread

        daemon.rows = daemon.rows.map { $0.setting("read_at", stamp(Date())) }
        daemon.failOlderPages = PilotError("offline")
        await store.refresh()
        XCTAssertEqual(store.records.map(\.id), shown)
        XCTAssertFalse(store.records.contains(where: \.isRead), "No page of the failed walk is applied")
        XCTAssertEqual(store.nextBeforeSeq, cursor)
        XCTAssertEqual(store.counts.unread, unread)
        XCTAssertNotNil(store.loadError)

        daemon.failOlderPages = nil
        await store.refresh()
        XCTAssertTrue(store.records.allSatisfy(\.isRead))
        XCTAssertNil(store.loadError)
    }

    func testAMutationDuringTheWalkDiscardsItAndRefetches() async throws {
        let daemon = FakeNotifications((1...300).map { row($0) })
        let store = centre(daemon)
        await store.refresh()
        for _ in 0..<4 { await store.loadMore() }
        let oldest = try XCTUnwrap(store.records.last)

        daemon.holdOlderPages = true
        async let walk: Void = store.refresh()
        await eventually("the second page") { daemon.heldCount == 1 }
        daemon.holdOlderPages = false
        await store.markRead(oldest, hostID: nil)
        daemon.release()
        await walk
        await eventually("the rerun") { !store.isLoading && daemon.lists.count > 7 }
        XCTAssertEqual(store.records.count, 250)
        XCTAssertTrue(try XCTUnwrap(store.records.last).isRead, "The stale walk does not undo the read")
    }

    func testAFilterChangeDropsAWalkInProgress() async {
        var rows = (1...300).map { row($0) }
        rows.append(row(301, bot: "ops"))
        let daemon = FakeNotifications(rows)
        let store = centre(daemon)
        await store.refresh()
        for _ in 0..<4 { await store.loadMore() }

        daemon.holdOlderPages = true
        async let walk: Void = store.refresh()
        await eventually("the second page") { daemon.heldCount == 1 }
        daemon.holdOlderPages = false
        store.setFilter(.bots)
        await eventually("the bots list") { store.hasLoaded && store.records.count == 1 }
        daemon.release()
        await walk
        XCTAssertEqual(store.records.map(\.id), ["N-301"], "The old walk cannot replace the new list")
    }

    func testAnOlderPageThatCrossesARefetchIsAskedForAgain() async {
        let daemon = FakeNotifications((1...100).map { row($0) })
        let store = centre(daemon)
        await store.refresh()
        daemon.holdLists = true
        async let older: Void = store.loadMore()
        await eventually("the held page") { daemon.heldCount == 1 }
        daemon.holdLists = false

        daemon.rows += (101...200).map { row($0) }
        await store.refresh()
        XCTAssertEqual(store.nextBeforeSeq, 151)
        daemon.release()
        await older

        await eventually("the page under the new cursor") { store.records.count == 100 }
        XCTAssertEqual(store.records.map(\.seq), Array((101...200).reversed()), "Nothing is appended past a gap")
        XCTAssertEqual(store.nextBeforeSeq, 101)
    }

    func testARefetchThatFinishesAfterAnOlderPageKeepsThatPage() async {
        let daemon = FakeNotifications((1...120).map { row($0) })
        let store = centre(daemon)
        await store.refresh()
        await store.loadMore()

        daemon.holdLists = true
        async let walk: Void = store.refresh()
        await eventually("the held refresh") { daemon.heldCount == 1 }
        daemon.holdLists = false
        await store.loadMore()
        XCTAssertEqual(store.records.count, 120)
        daemon.release()
        await walk

        await eventually("the rerun") { !store.isLoading && daemon.lists.count > 4 }
        XCTAssertEqual(store.records.count, 120, "The list does not shrink under the reader")
        XCTAssertNil(store.nextBeforeSeq)
    }

    func testARefreshedRecordMovesToTheTopWithoutRepeating() async {
        let daemon = FakeNotifications((1...3).map { row($0) })
        let store = centre(daemon)
        await store.refresh()
        daemon.rows.removeAll { $0["seq"].int == 1 }
        daemon.rows.append(row(4).setting("id", .string("N-1")))
        await store.refresh()
        XCTAssertEqual(store.records.map(\.id), ["N-1", "N-3", "N-2"])
    }

    // MARK: Filters

    func testFilterRequestsTheDaemonAndNarrowsImmediately() async {
        let daemon = FakeNotifications([row(1, kind: "review"), row(2, kind: "review", resolved: true), row(3),
                                        row(4, bot: "Juno"), row(5, kind: "agent_notice")])
        let store = centre(daemon)
        await store.refresh()
        store.setFilter(.needsYou)
        XCTAssertEqual(store.records.map(\.id), ["N-1"], "Rows narrow before the response")
        await eventually("needs-you response") { store.hasLoaded }
        XCTAssertTrue(daemon.lists.contains { $0.query.first { $0.name == "filter" }?.value == "needs_you" })
        store.setFilter(.bots)
        await eventually("bots response") { store.hasLoaded }
        XCTAssertEqual(store.records.map(\.id), ["N-5", "N-4"])
        store.setFilter(.all)
        await eventually("all response") { store.hasLoaded }
        XCTAssertEqual(store.records.count, 5)
        XCTAssertEqual(store.counts.needsYou, 1)
    }

    func testAResponseForAnAbandonedFilterIsDropped() async {
        let daemon = FakeNotifications([row(1), row(2, kind: "review")])
        let store = centre(daemon)
        await store.refresh()
        daemon.holdLists = true
        async let slow: Void = store.refresh()
        await eventually("held list") { daemon.heldCount == 1 }
        daemon.holdLists = false
        store.setFilter(.needsYou)
        await eventually("needs-you response") { store.hasLoaded }
        daemon.release()
        await slow
        XCTAssertEqual(store.records.map(\.id), ["N-2"])
    }

    // MARK: Day grouping

    func testDayGroupingNamesRecentDaysAndNeverSplitsADay() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Europe/London"))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 4, hour: 9)))
        func ago(days: Int, hour: Int = 8) -> Date {
            calendar.date(byAdding: .day, value: -days, to: calendar.date(bySettingHour: hour, minute: 0, second: 0, of: now)!)!
        }
        let dates: [String: Date] = ["today": ago(days: 0), "stepped": ago(days: 0, hour: 1), "yesterday": ago(days: 1),
                                     "monday": ago(days: 2), "old": ago(days: 400)]
        let rows = ["today", "yesterday", "stepped", "monday", "old"].enumerated().map { index, key in
            NotificationRecord(row(10 - index).setting("created_at", .string(key)))
        }
        let sections = NotificationDayGrouping.sections(rows, now: now, calendar: calendar, locale: Locale(identifier: "en_GB")) { dates[$0] }
        XCTAssertEqual(sections.map(\.title), ["Today", "Yesterday", "Mon 2 Nov", "30 Sep 2025"])
        XCTAssertEqual(sections[0].records.map(\.seq), [10, 8], "A clock step must not start a second Today")
    }

    func testBadgeCapsAtNinetyNine() {
        XCTAssertNil(NotificationBadge.label(0))
        XCTAssertEqual(NotificationBadge.label(7), "7")
        XCTAssertEqual(NotificationBadge.label(99), "99")
        XCTAssertEqual(NotificationBadge.label(100), "99+")
    }

    // MARK: Read state

    func testMarkReadIsOptimisticAndSendsTheID() async throws {
        let daemon = FakeNotifications([row(1), row(2)])
        let store = centre(daemon)
        await store.refresh()
        daemon.holdReads = true
        let target = try XCTUnwrap(store.records.first { $0.id == "N-1" })
        async let done: Void = store.markRead(target, hostID: nil)
        await eventually("held read") { daemon.heldCount == 1 }
        XCTAssertEqual(store.records.first { $0.id == "N-1" }?.isRead, true)
        XCTAssertEqual(store.counts.unread, 1)
        daemon.release()
        await done
        XCTAssertEqual(daemon.reads.last?.body, .object(["ids": .array([.string("N-1")])]))
        XCTAssertEqual(store.counts.unread, 1)
    }

    func testAFailedReadRollsBackWithAReason() async throws {
        let daemon = FakeNotifications([row(1), row(2)])
        let store = centre(daemon)
        await store.refresh()
        daemon.failReads = PilotError("offline")
        await store.markRead(try XCTUnwrap(store.records.first), hostID: nil)
        XCTAssertEqual(store.records.filter(\.isRead).count, 0)
        XCTAssertEqual(store.counts.unread, 2)
        XCTAssertEqual(store.message, "Couldn’t mark as read. offline")
        await store.markAllRead()
        XCTAssertEqual(store.records.filter(\.isRead).count, 0, "Mark-all rolls back too")
        XCTAssertEqual(store.counts.unread, 2)
    }

    func testAnAlreadyReadRowSendsNothing() async throws {
        let daemon = FakeNotifications([row(1, read: true)])
        let store = centre(daemon)
        await store.refresh()
        await store.markRead(try XCTUnwrap(store.records.first), hostID: nil)
        XCTAssertTrue(daemon.reads.isEmpty)
    }

    func testMarkAllSendsLatestSeqSoANewerRecordStaysUnread() async {
        let daemon = FakeNotifications([row(1), row(2)])
        let store = centre(daemon)
        await store.refresh()
        daemon.rows.append(row(3))   // Arrived after James last looked.
        await store.markAllRead()
        XCTAssertEqual(daemon.reads.last?.body, .object(["up_to_seq": .number(2)]))
        XCTAssertNil(daemon.reads.last?.body?["ids"].array.first)
        XCTAssertEqual(store.counts.unread, 1, "The daemon's count wins once it answers")
        XCTAssertFalse(NotificationRecord(daemon.rows.last!).isRead)
    }

    func testOverlappingReadsAreSettledByARefresh() async {
        let daemon = FakeNotifications([row(1), row(2)])
        let store = centre(daemon)
        await store.refresh()
        let listed = daemon.lists.count
        daemon.holdReads = true
        async let first: Void = store.markRead(store.records[0], hostID: nil)
        async let second: Void = store.markRead(store.records[1], hostID: nil)
        await eventually("both reads held") { daemon.heldCount == 2 }
        daemon.holdReads = false
        daemon.release()
        _ = await (first, second)
        await eventually("a settling refresh") { daemon.lists.count > listed }
        await eventually("the daemon's counts") { store.counts.unread == 0 }
    }

    func testOnlyAHeadReadMovesTheMarkAllBoundary() async {
        let daemon = FakeNotifications((1...60).map { row($0) })
        let store = centre(daemon)
        await store.refresh()
        XCTAssertEqual(store.counts.latestSeq, 60)
        daemon.rows.append(row(61))
        await store.loadMore()
        XCTAssertEqual(store.counts.latestSeq, 60, "61 was never on screen")
        await store.markRead(store.records[0], hostID: nil)
        XCTAssertEqual(store.counts.latestSeq, 60, "A mark-read answer is not a head read")
        await store.markAllRead()
        XCTAssertEqual(daemon.reads.last?.body, .object(["up_to_seq": .number(60)]))
    }

    func testMarkAllDoesNothingWhenAllRead() async {
        let daemon = FakeNotifications([row(1, read: true)])
        let store = centre(daemon)
        await store.refresh()
        XCTAssertFalse(store.canMarkAllRead)
        await store.markAllRead()
        XCTAssertTrue(daemon.reads.isEmpty)
    }

    func testAListStartedBeforeAMutationCannotUndoIt() async throws {
        let daemon = FakeNotifications([row(1), row(2)])
        let store = centre(daemon)
        await store.refresh()
        let target = try XCTUnwrap(store.records.first { $0.id == "N-2" })

        daemon.holdLists = true
        async let staleRefresh: Void = store.refresh()
        await eventually("held list") { daemon.heldCount == 1 }
        daemon.holdLists = false
        await store.markRead(target, hostID: nil)
        XCTAssertEqual(store.counts.unread, 1)
        let listsBefore = daemon.lists.count
        daemon.release()     // Still says N-2 is unread and two are unread.
        await staleRefresh
        XCTAssertEqual(store.records.first { $0.id == "N-2" }?.isRead, true)
        XCTAssertEqual(store.counts.unread, 1)
        await eventually("the refetch after the dropped response") { daemon.lists.count > listsBefore }
    }

    func testAListStartedDuringAMutationWaitsForIt() async throws {
        let daemon = FakeNotifications([row(1), row(2)])
        let store = centre(daemon)
        await store.refresh()
        daemon.holdReads = true
        let target = try XCTUnwrap(store.records.first { $0.id == "N-2" })
        async let read: Void = store.markRead(target, hostID: nil)
        await eventually("held read") { daemon.heldCount == 1 }
        await store.refresh()   // The daemon has not seen the read yet.
        XCTAssertEqual(store.records.first { $0.id == "N-2" }?.isRead, true)
        XCTAssertEqual(store.counts.unread, 1)
        daemon.holdReads = false
        daemon.release()
        await read
        XCTAssertEqual(store.records.first { $0.id == "N-2" }?.isRead, true)
    }

    func testAPageStartedBeforeAMutationIsRefetched() async throws {
        let daemon = FakeNotifications((1...60).map { row($0) })
        let store = centre(daemon)
        await store.refresh()
        daemon.holdLists = true
        async let page: Void = store.loadMore()
        await eventually("held page") { daemon.heldCount == 1 }
        daemon.holdLists = false
        await store.markAllRead()
        daemon.release()
        await page
        await eventually("the older page") { store.records.count == 60 }
        XCTAssertTrue(store.records.allSatisfy(\.isRead))
    }

    // MARK: Older daemons

    func testAnOlderDaemonHidesTheBellRatherThanErroring() async {
        for failure: Error in [PilotError("Daemon request failed (HTTP 404).", status: 404),
                               PilotError("unsupported remote rpc method `notifications.list`")] {
            let daemon = FakeNotifications()
            daemon.failure = failure
            let store = centre(daemon)
            store.isPresented = true
            await store.refresh()
            XCTAssertTrue(store.unsupported)
            XCTAssertNil(store.loadError)
            XCTAssertFalse(store.isPresented)
        }
    }

    func testAnOrdinaryFailureKeepsTheBellAndARecoversWhenReconnected() async {
        let daemon = FakeNotifications([row(1)])
        daemon.failure = PilotError("The computer took too long to respond.")
        let store = centre(daemon)
        await store.refresh()
        XCTAssertFalse(store.unsupported)
        XCTAssertNotNil(store.loadError)
        daemon.failure = nil
        store.connected(hostID: nil)
        await eventually("recovery") { store.records.count == 1 }
        XCTAssertNil(store.loadError)
    }

    func testAnUpgradedDaemonGetsItsBellBack() async {
        let daemon = FakeNotifications([row(1)])
        daemon.failure = PilotError("", status: 404)
        let store = centre(daemon)
        await store.refresh()
        XCTAssertTrue(store.unsupported)
        daemon.failure = nil
        store.connected(hostID: nil)
        await eventually("bell") { !store.unsupported }
        XCTAssertEqual(store.counts.unread, 1)
    }

    // MARK: Events and hosts

    func testEventsWithTheDomainRefetchOnceAfterTheDebounce() async {
        let daemon = FakeNotifications([row(1)])
        let store = centre(daemon, debounce: .milliseconds(20))
        await store.refresh()
        let baseline = daemon.lists.count
        store.receive(controlEvent("automations"), hostID: nil)
        store.receive(.object(["type": .string("snapshot")]), hostID: nil)
        try? await Task.sleep(for: .milliseconds(60))
        XCTAssertEqual(daemon.lists.count, baseline, "Other domains are not ours")

        daemon.rows.append(row(2))
        store.receive(controlEvent("notifications"), hostID: nil)
        store.receive(controlEvent("reviews", "notifications"), hostID: nil)
        store.receive(controlEvent("notifications"), hostID: nil)
        await eventually("refetch") { store.records.count == 2 }
        try? await Task.sleep(for: .milliseconds(60))
        XCTAssertEqual(daemon.lists.count, baseline + 1, "A burst debounces to one fetch")
        XCTAssertEqual(store.reviewRevision, 1)
    }

    func testSwitchingHostFollowsItAndDropsTheOldHostsResponse() async {
        let daemon = FakeNotifications([row(1)])
        let store = centre(daemon)
        await store.refresh()
        XCTAssertEqual(store.counts.unread, 1)

        daemon.holdLists = true
        async let stale: Void = store.refresh()
        await eventually("held list") { daemon.heldCount == 1 }
        daemon.holdLists = false
        daemon.rows = [row(5), row(6)]
        store.follow(hostID: "server-a")
        XCTAssertTrue(store.records.isEmpty, "One host's rows never show under another")
        XCTAssertEqual(store.counts.unread, 0)
        await eventually("server-a") { store.records.count == 2 }
        XCTAssertEqual(daemon.lists.last?.host, "server-a")
        daemon.rows = [row(9)]
        daemon.release()
        await stale
        XCTAssertEqual(store.records.map(\.id), ["N-6", "N-5"])
    }

    func testAMutationFromAnAbandonedHostChangesNothing() async throws {
        let daemon = FakeNotifications([row(1)])
        let store = centre(daemon)
        await store.refresh()
        daemon.holdReads = true
        daemon.failReads = PilotError("offline")
        let target = try XCTUnwrap(store.records.first)
        async let read: Void = store.markRead(target, hostID: nil)
        await eventually("held read") { daemon.heldCount == 1 }
        daemon.rows = [row(5), row(6)]
        store.follow(hostID: "server-a")
        await eventually("server-a") { store.records.count == 2 }
        daemon.release()
        await read
        XCTAssertEqual(store.counts.unread, 2)
        XCTAssertNil(store.message)
    }

    func testUnsupportedIsRememberedPerHost() async {
        let daemon = FakeNotifications([row(1)])
        let store = centre(daemon)
        await store.refresh()
        daemon.failure = PilotError("unsupported remote rpc method `notifications.list`")
        store.follow(hostID: "old")
        await eventually("old host") { store.unsupported }
        daemon.failure = nil
        store.follow(hostID: nil)
        XCTAssertFalse(store.unsupported, "The local daemon keeps its bell at once")
        await eventually("local rows") { store.records.count == 1 }
    }

    // MARK: Banners

    func testFirstLoadSeedsSoALaunchDoesNotReplayHistory() async {
        let daemon = FakeNotifications([row(1, kind: "agent_notice"), row(2, kind: "agent_notice")])
        let store = centre(daemon)
        var banners: [String] = []
        store.onNewNotice = { record, _ in banners.append(record.id) }
        await store.refresh()
        await store.refresh()
        XCTAssertTrue(banners.isEmpty)
    }

    func testANewNoticeBannersOnceAndOtherKindsDoNot() async {
        let daemon = FakeNotifications([row(1)])
        let store = centre(daemon)
        var banners: [(String, String?)] = []
        store.onNewNotice = { record, host in banners.append((record.id, host)) }
        await store.refresh()
        daemon.rows += [row(2, kind: "input_required"), row(3, kind: "error"), row(4, kind: "agent_notice"),
                        row(5, kind: "agent_notice", read: true)]
        await store.refresh()
        await store.refresh()
        XCTAssertEqual(banners.map(\.0), ["N-4"], "Read on another device, or a repeat fetch, stays quiet")
        XCTAssertNil(banners.first?.1)
    }

    func testANoticeIsFoundWhileTheListShowsNeedsYou() async {
        let daemon = FakeNotifications([row(1)])
        let store = centre(daemon)
        var banners: [String] = []
        store.onNewNotice = { record, _ in banners.append(record.id) }
        await store.refresh()
        store.setFilter(.needsYou)
        await eventually("filter") { store.hasLoaded }
        daemon.rows.append(row(2, kind: "agent_notice"))
        await store.refresh()
        XCTAssertEqual(banners, ["N-2"])
    }

    func testABacklogCapsBannersButTheListHasThemAll() async {
        let daemon = FakeNotifications([row(1)])
        let store = centre(daemon)
        var banners: [String] = []
        store.onNewNotice = { record, _ in banners.append(record.id) }
        await store.refresh()
        daemon.rows += (2...9).map { row($0, kind: "agent_notice") }
        await store.refresh()
        XCTAssertEqual(banners, ["N-7", "N-8", "N-9"])
        XCTAssertEqual(store.records.count, 9)
    }

    func testAHostTheWindowIsNotShowingStillRaisesItsNotices() async {
        let daemon = FakeNotifications([row(1, kind: "agent_notice")])
        let store = centre(daemon)
        var banners: [(String, String?)] = []
        store.onNewNotice = { record, host in banners.append((record.id, host)) }
        await store.refresh()
        store.connected(hostID: "server-a")
        await eventually("host seed") { daemon.lists.contains { $0.host == "server-a" } }
        daemon.rows.append(row(2, kind: "agent_notice"))
        store.receive(controlEvent("notifications"), hostID: "server-a")
        await eventually("host banner") { !banners.isEmpty }
        XCTAssertEqual(banners.map(\.0), ["N-2"])
        XCTAssertEqual(banners.first?.1, "server-a")
        XCTAssertEqual(store.records.map(\.id), ["N-1"], "The list stays on the selected host")
    }

    func testAgentNoticeBannerRespectsPreferencesViewingAndRepeats() async {
        var notices: [(NativeAttentionNotice, String?)] = []
        var viewed = false
        let platform = NativePlatform(sound: { _ in }, badge: { _ in },
            noticeDelivery: { notices.append(($0, $1)) }, viewed: { _, _ in viewed })
        let record = NotificationRecord(row(7, kind: "agent_notice", bot: "Juno")
            .setting("thread_id", .string("remote:server-a:task")).setting("workspace_id", .string("remote:server-a:project")))

        await platform.deliverAgentNotice(record, hostID: "server-a")
        await platform.deliverAgentNotice(record, hostID: "server-a")
        XCTAssertEqual(notices.count, 1, "One banner per record")
        XCTAssertEqual(notices.first?.0.notificationID, "N-7")
        XCTAssertEqual(notices.first?.0.taskID, "task", "Delivery uses the host's own ids")
        XCTAssertEqual(notices.first?.0.title, "Juno: Row 7")
        XCTAssertEqual(notices.first?.1, "server-a")

        viewed = true
        await platform.deliverAgentNotice(NotificationRecord(row(8, kind: "agent_notice")), hostID: nil)
        XCTAssertEqual(notices.count, 1, "Not while James is viewing it")

        viewed = false
        platform.handle(.object(["event": .object(["type": .string("snapshot"), "snapshot": .object([
            "threads": .array([]), "preferences": .object(["notifications": .object(["enabled": .bool(false)])])
        ])])]), hostID: nil)
        await platform.deliverAgentNotice(NotificationRecord(row(9, kind: "agent_notice")), hostID: nil)
        XCTAssertEqual(notices.count, 1, "Not when notifications are off")
    }

    // MARK: Destinations

    func testABodyWinsAndTargetsParse() {
        let thread = JSON.object(["type": .string("thread"), "workspace_id": .string("p"), "thread_id": .string("t")])
        let review = JSON.object(["type": .string("review"), "review_id": .string("R-3")])
        XCTAssertEqual(NotificationRecord(row(1, target: thread)).destination, .thread(projectID: "p", taskID: "t"))
        XCTAssertEqual(NotificationRecord(row(2, target: review)).destination, .review("R-3"))
        XCTAssertEqual(NotificationRecord(row(3, body: true, target: thread)).destination, .report("N-3"))
        XCTAssertEqual(NotificationRecord(row(3, body: true, target: thread)).target, .thread(projectID: "p", taskID: "t"))
        XCTAssertEqual(NotificationRecord(row(4)).destination, .nothing)
        XCTAssertEqual(NotificationRecord(row(5, target: .object(["type": .string("somewhere_new")]))).destination, .nothing)
    }

    func testResolvedOnlyAppliesToRequests() {
        XCTAssertTrue(NotificationRecord(row(1, kind: "review", resolved: true)).wasDealtWith)
        XCTAssertFalse(NotificationRecord(row(2, kind: "review")).wasDealtWith)
        XCTAssertFalse(NotificationRecord(row(3, resolved: true)).wasDealtWith)
        XCTAssertEqual(NotificationRowPresentation(NotificationRecord(row(1, kind: "review", resolved: true, bot: "Juno"))).detail, "Resolved · Juno")
    }
}

// MARK: - Remote mapping

final class NotificationRemoteTests: XCTestCase {
    func testRoutesMapToTheRegisteredRPCs() throws {
        let list = try NativeRemoteRequestRouter.route(["api", "notifications"], query: [
            .init(name: "filter", value: "needs_you"), .init(name: "limit", value: "50"), .init(name: "before_seq", value: "41")])
        XCTAssertEqual(list.method, "notifications.list")
        XCTAssertEqual(list.params, .object(["filter": .string("needs_you"), "limit": .number(50), "before_seq": .number(41)]))

        let read = try NativeRemoteRequestRouter.route(["api", "notifications", "read"], method: "POST", body: .object(["up_to_seq": .number(9)]))
        XCTAssertEqual(read.method, "notifications.mark_read")
        XCTAssertEqual(read.params, .object(["up_to_seq": .number(9)]))

        let one = try NativeRemoteRequestRouter.route(["api", "notifications", "N-41"])
        XCTAssertEqual(one.method, "notification.get")
        XCTAssertEqual(one.params, .object(["id": .string("N-41")]))

        let review = try NativeRemoteRequestRouter.route(["api", "reviews", "R-1"])
        XCTAssertEqual(review.method, "review.get")
        XCTAssertEqual(review.params, .object(["id": .string("R-1")]))

        let respond = try NativeRemoteRequestRouter.route(["api", "reviews", "R-1", "respond"], method: "POST", body: .object(["decision": .string("approve")]))
        XCTAssertEqual(respond.method, "review.respond")
        XCTAssertEqual(respond.params, .object(["review_id": .string("R-1"), "decision": .string("approve")]))
    }

    func testRecordsAndReviewsAreScopedToTheirHost() {
        let record = JSON.object(["id": .string("N-1"), "workspace_id": .string("w"), "thread_id": .string("t"),
            "target": .object(["type": .string("thread"), "workspace_id": .string("w"), "thread_id": .string("t")])])
        let host = "server-a"
        let page = NativeHostProjection.response(.object(["items": .array([record]), "latest_seq": .number(1)]), host: host, path: ["api", "notifications"])
        let projected = NotificationRecord(page["items"].array[0])
        XCTAssertEqual(projected.target, .thread(projectID: "remote:server-a:w", taskID: "remote:server-a:t"))
        XCTAssertEqual(projected.threadID, "remote:server-a:t")
        XCTAssertEqual(projected.id, "N-1", "Record ids belong to the daemon, not a task")

        let single = NativeHostProjection.response(record, host: host, path: ["api", "notifications", "N-1"])
        XCTAssertEqual(NotificationRecord(single).workspaceID, "remote:server-a:w")

        let reviewTarget = NativeHostProjection.notification(.object(["target": .object(["type": .string("review"), "review_id": .string("R-1")])]), host: host)
        XCTAssertEqual(NotificationRecord(reviewTarget).target, .review("R-1"))

        let review = NativeHostProjection.response(.object(["data": .object(["id": .string("R-1"), "source_thread_id": .string("t")])]), host: host, path: ["api", "reviews", "R-1"])
        XCTAssertEqual(review["data"]["source_thread_id"].string, "remote:server-a:t")
        XCTAssertEqual(review["data"]["id"].string, "R-1")
    }
}

// MARK: - Opening records

private actor NotificationNavigationDaemon: DaemonServing {
    func snapshot() async throws -> JSON { .object([:]) }
    func threadDetail(projectID: String, threadID: String, before: String?) async throws -> JSON {
        .object(["thread": .object(["id": .string(threadID), "workspace_id": .string(projectID), "attention": .object([:])]), "items": .array([])])
    }
    func connectProject(path: String) async throws -> Project { throw PilotError("unused") }
    func startThread(projectID: String, provider: String?, modelID: String?) async throws -> AgentTask { throw PilotError("unused") }
    func sendTurn(projectID: String, threadID: String, text: String, userItemID: String?) async throws -> JSON { .null }
    func interrupt(projectID: String, threadID: String) async throws {}
    func respond(projectID: String, requestID: String, response: JSON) async throws {}
    func markRead(projectID: String, threadID: String, readSeq: Int) async throws {}
    func events() async throws -> AsyncThrowingStream<JSON, Error> { AsyncThrowingStream { $0.finish() } }
    func disconnect() async {}
    private(set) var reads: [JSON] = []
    func requestJSON(_ path: [String], method: String, query: [URLQueryItem], body: JSON?) async throws -> JSON {
        if path == ["api", "notifications", "read"] {
            reads.append(body ?? .null)
            return .object(["unread_count": .number(0), "needs_you_count": .number(0), "latest_seq": .number(1)])
        }
        if path == ["api", "notifications"] {
            return .object(["items": .array([]), "unread_count": .number(0), "needs_you_count": .number(0), "latest_seq": .number(1)])
        }
        throw PilotError("Not found", status: 404)
    }
}

@MainActor final class NotificationNavigationTests: XCTestCase {
    private func store() -> (AppStore, NotificationNavigationDaemon) {
        let daemon = NotificationNavigationDaemon()
        let store = AppStore(client: daemon, readVisibility: { false })
        store.applyEnvelope(.object(["event": .object(["type": .string("snapshot"), "snapshot": .object([
            "workspaces": .array([.object(["id": .string("p"), "path": .string("/tmp/p"), "kind": .string("project")])]),
            "threads": .array([.object(["id": .string("t"), "workspace_id": .string("p"), "provider": .string("claude"), "title": .string("Task"),
                                        "status": .string("idle"), "updated_at": .string("2026-11-04T08:00:00Z"), "attention": .object([:])])]),
            "interactive_requests": .array([])])])]))
        return (store, daemon)
    }

    private func threadRecord(_ task: String) -> NotificationRecord {
        NotificationRecord(row(1, target: .object(["type": .string("thread"), "workspace_id": .string("p"), "thread_id": .string(task)])))
    }

    func testTappingAThreadRecordSelectsTheTaskAndReadsTheRecord() async {
        let (store, daemon) = store()
        store.selectSection("settings")
        XCTAssertTrue(store.openNotification(threadRecord("t"), hostID: nil))
        await eventually("task") { store.selectedTaskID == "t" && store.selectedSection == "project" }
        var reads = await daemon.reads
        for _ in 0..<100 where reads.isEmpty {
            try? await Task.sleep(for: .milliseconds(5))
            reads = await daemon.reads
        }
        XCTAssertEqual(reads, [.object(["ids": .array([.string("N-1")])])])
    }

    func testAThreadThatNoLongerExistsSaysSoInTheCentre() {
        let (store, _) = store()
        store.selectSection("settings")
        XCTAssertFalse(store.openNotification(threadRecord("gone"), hostID: nil))
        XCTAssertEqual(store.notifications.message, AppStore.missingTaskMessage)
        XCTAssertTrue(store.notifications.isPresented)
        XCTAssertEqual(store.selectedSection, "settings", "Nothing navigates")
    }

    func testAReportOpensInTheReaderAndBackReturns() async {
        let (store, _) = store()
        await store.selectTask("t")
        store.selectSection("automations")
        XCTAssertTrue(store.openNotification(NotificationRecord(row(2, kind: "agent_notice", body: true)), hostID: "server-a"))
        XCTAssertEqual(store.selectedSection, "notification")
        XCTAssertEqual(store.selectedReader, .report(id: "N-2", hostID: "server-a"))
        await store.closeNotificationReader()
        XCTAssertEqual(store.selectedSection, "automations")
        await store.navigateHistory(1)
        XCTAssertEqual(store.selectedSection, "notification")
        XCTAssertEqual(store.selectedReader, .report(id: "N-2", hostID: "server-a"), "Forward reopens the same record")
    }

    func testAReviewTargetOpensTheReviewReader() {
        let (store, _) = store()
        let record = NotificationRecord(row(3, kind: "review", target: .object(["type": .string("review"), "review_id": .string("R-9")])))
        XCTAssertTrue(store.openNotification(record, hostID: nil))
        XCTAssertEqual(store.selectedReader, .review(id: "R-9", hostID: nil))
    }

    func testARestartDoesNotReturnToAnEmptyReader() {
        XCTAssertEqual(AppStore.restoredSection("notification"), "project")
    }

    func testControlEventsReachTheCentreFromAnyHost() async {
        let (store, _) = store()
        store.applyEnvelope(.object(["event": controlEvent("reviews")]))
        XCTAssertEqual(store.notifications.reviewRevision, 1)
        store.applyEnvelope(.object(["event": controlEvent("reviews")]), originHost: "server-a", notifyPlatform: false)
        XCTAssertEqual(store.notifications.reviewRevision, 2)
    }
}

// MARK: - Review detail

@MainActor private final class FakeReviewDaemon {
    var review: JSON
    var calls: [(path: [String], method: String, body: JSON?)] = []
    var response: JSON?
    var failure: Error?
    var holdReads = false
    var holdPosts = false
    private var held: [CheckedContinuation<Void, Never>] = []
    private var heldPosts: [CheckedContinuation<Void, Never>] = []

    init(status: String = "open") {
        review = .object(["id": .string("R-1"), "title": .string("Pricing page"), "ask": .string("Ship the hero?"),
            "recommendation": .string("Ship it."), "body": .string("# Context"), "status": .string(status),
            "going_ahead_at": .string("2026-11-04T17:00:00Z"), "source_thread_id": .string("t"), "bot": .string("Juno"),
            "items": .array([.object(["id": .string("i1"), "title": .string("Hero"), "note": .string("Look at the fold"),
                "evidence": .array([
                    .object(["id": .string("e1"), "kind": .string("image"), "title": .string("Mock-up")]),
                    .object(["id": .string("e2"), "kind": .string("file"), "original_path": .string("/tmp/report.pdf")]),
                    .object(["id": .string("e3"), "kind": .string("url"), "url": .string("https://example.com/a")])
                ])])])])
    }
    var heldCount: Int { held.count }
    var heldPostCount: Int { heldPosts.count }
    func release() { let waiting = held; held = []; waiting.forEach { $0.resume() } }
    func releasePosts() { let waiting = heldPosts; heldPosts = []; waiting.forEach { $0.resume() } }

    func transport(_ path: [String], _ method: String, _ query: [URLQueryItem], _ body: JSON?, _ host: String?) async throws -> JSON {
        calls.append((path, method, body))
        if let failure { throw failure }
        if method == "POST" {
            if holdPosts { await withCheckedContinuation { heldPosts.append($0) } }
            if let response { return response }
            review = review.setting("status", .string("approved"))
            return .object(["ok": .bool(true), "operation": .string("review.respond"), "data": review])
        }
        let answer = review
        if holdReads { await withCheckedContinuation { held.append($0) } }
        return .object(["resource": .string("review"), "data": answer])
    }
}

@MainActor final class NotificationReviewModelTests: XCTestCase {
    private func model(_ daemon: FakeReviewDaemon) -> NotificationReviewModel {
        NotificationReviewModel(id: "R-1", hostID: nil) { try await daemon.transport($0, $1, $2, $3, $4) }
    }

    func testLoadReadsTheControlEnvelope() async throws {
        let daemon = FakeReviewDaemon()
        let model = model(daemon)
        await model.load()
        let review = try XCTUnwrap(model.review)
        XCTAssertEqual(review.ask, "Ship the hero?")
        XCTAssertTrue(review.isOpen)
        XCTAssertEqual(review.statusTitle, "Waiting for you")
        XCTAssertEqual(review.items.first?.evidence.map(\.name), ["Mock-up", "report.pdf", "https://example.com/a"])
        XCTAssertEqual(daemon.calls.first?.path, ["api", "reviews", "R-1"])
    }

    func testRespondSendsDecisionAndNoteAndShowsTheClosedReview() async {
        let daemon = FakeReviewDaemon()
        let model = model(daemon)
        await model.load()
        model.note = "  Keep the badge.  "
        await model.respond(.requestChanges)
        XCTAssertEqual(daemon.calls.last?.path, ["api", "reviews", "R-1", "respond"])
        XCTAssertEqual(daemon.calls.last?.body, .object(["decision": .string("request_changes"), "note": .string("Keep the badge.")]))
        XCTAssertEqual(model.review?.status, "approved")
        XCTAssertEqual(model.note, "")
    }

    func testAnEmptyNoteIsOmitted() async {
        let daemon = FakeReviewDaemon()
        let model = model(daemon)
        await model.load()
        await model.respond(.approve)
        XCTAssertEqual(daemon.calls.last?.body, .object(["decision": .string("approve")]))
    }

    func testARefusalInsideTheEnvelopeIsShownAndTheRealStateLoaded() async {
        let daemon = FakeReviewDaemon()
        let model = model(daemon)
        await model.load()
        model.note = "typed"
        daemon.review = daemon.review.setting("status", .string("withdrawn"))
        daemon.response = .object(["ok": .bool(false), "operation": .string("review.respond"),
            "error": .object(["code": .string("review_closed"), "message": .string("Review R-1 is closed.")])])
        await model.respond(.approve)
        XCTAssertEqual(model.responseError, "Review R-1 is closed.")
        XCTAssertEqual(model.review?.status, "withdrawn")
        XCTAssertEqual(model.note, "typed", "James keeps what he wrote")
    }

    func testAReadStartedBeforeAnAnswerCannotReopenTheReview() async {
        let daemon = FakeReviewDaemon()
        let model = model(daemon)
        await model.load()
        daemon.holdReads = true
        async let stale: Void = model.load()
        await eventually("held read") { daemon.heldCount == 1 }
        daemon.holdReads = false
        await model.respond(.approve)
        daemon.release()
        await stale
        XCTAssertEqual(model.review?.status, "approved")
    }

    func testAReadStartedDuringAnAnswerCannotReopenTheReview() async {
        let daemon = FakeReviewDaemon()
        let model = model(daemon)
        await model.load()
        daemon.holdPosts = true
        async let answer: Void = model.respond(.approve)
        await eventually("held answer") { daemon.heldPostCount == 1 }
        daemon.holdReads = true
        async let stale: Void = model.load()
        await eventually("held read") { daemon.heldCount == 1 }
        daemon.releasePosts()
        await answer
        daemon.release()
        await stale
        XCTAssertEqual(model.review?.status, "approved")
    }

    func testAMissingReviewSaysSo() async {
        let daemon = FakeReviewDaemon()
        daemon.failure = PilotError("Review R-1 was not found.", status: 404)
        let model = model(daemon)
        await model.load()
        XCTAssertEqual(model.loadError, "This review is no longer available.")
    }
}
