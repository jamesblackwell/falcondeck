import XCTest
@testable import FalconDeckMac

@MainActor final class NativePlatformTests: XCTestCase {
    private func task(status: String = "idle", turn: String = "turn-1", read: Int = 0, activity: Int = 10,
                      pending: Int = 0, updated: String = "2026-10-20T10:00:00Z") -> JSON {
        .object([
            "id": .string("task"), "workspace_id": .string("project"), "title": .string("Review"),
            "status": .string(status), "latest_turn_id": .string(turn), "updated_at": .string(updated),
            "attention": .object(["last_agent_activity_seq": .number(Double(activity)),
                                   "last_read_seq": .number(Double(read)), "unread": .bool(activity > read),
                                   "pending_question_count": .number(Double(pending))])
        ])
    }

    private func snapshot(_ tasks: [JSON], notifications: JSON = .object([:])) -> JSON {
        .object(["event": .object(["type": .string("snapshot"), "snapshot": .object([
            "threads": .array(tasks), "preferences": .object(["notifications": notifications])
        ])])])
    }

    private func update(_ task: JSON) -> JSON {
        .object(["event": .object(["type": .string("thread-updated"), "thread": task])])
    }

    private func end(_ turn: String, status: String = "completed") -> JSON {
        .object(["thread_id": .string("task"), "event": .object([
            "type": .string("turn-end"), "turn_id": .string(turn), "status": .string(status)
        ])])
    }

    func testSnapshotAndReplayStayQuietButFreshTurnsRingOncePerHost() async throws {
        let suite = "NativePlatformTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativePreferences(defaults: defaults)
        preferences.soundEnabled = true
        var sounds: [String] = []
        var notices: [(NativeAttentionNotice, String?)] = []
        let platform = NativePlatform(preferences: preferences, sound: { sounds.append($0) }, badge: { _ in },
            noticeDelivery: { notices.append(($0, $1)) }, viewed: { _, _ in false })

        for host in [nil, "server-a"] as [String?] {
            platform.handle(snapshot([task()]), hostID: host)
            await platform.flush(host ?? "local")
            platform.handle(end("turn-1"), hostID: host)
        }
        XCTAssertTrue(sounds.isEmpty)
        XCTAssertTrue(notices.isEmpty)

        for host in [nil, "server-a"] as [String?] {
            platform.handle(update(task(turn: "turn-2", activity: 20, updated: "2026-10-20T10:01:00Z")), hostID: host)
            platform.handle(end("turn-2"), hostID: host)
            platform.handle(end("turn-2"), hostID: host)
            await platform.flush(host ?? "local")
        }
        XCTAssertEqual(sounds.count, 2)
        XCTAssertEqual(notices.count, 2)
        XCTAssertEqual(Set(notices.map { $0.1 ?? "local" }), ["local", "server-a"])
    }

    func testRunningSnapshotDoesNotSuppressItsFutureCompletionSound() async throws {
        let suite = "NativePlatformTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = NativePreferences(defaults: defaults)
        preferences.soundEnabled = true
        var sounds = 0
        let platform = NativePlatform(preferences: preferences, sound: { _ in sounds += 1 }, badge: { _ in },
            noticeDelivery: { _, _ in }, viewed: { _, _ in false })
        platform.handle(snapshot([task(status: "running")]))
        platform.handle(end("turn-1"))
        platform.handle(end("turn-1"))
        XCTAssertEqual(sounds, 1)
        platform.handle(end("turn-failed", status: "failed"))
        XCTAssertEqual(sounds, 1)
    }

    func testReadSnapshotDoesNotBecomeUnreadFromSameTimestampReplay() async {
        var notices: [NativeAttentionNotice] = []
        let platform = NativePlatform(sound: { _ in }, badge: { _ in },
            noticeDelivery: { notice, _ in notices.append(notice) }, viewed: { _, _ in false })
        platform.handle(snapshot([task(read: 10)]))
        await platform.flush("local")
        platform.handle(update(task()))
        await platform.flush("local")
        XCTAssertTrue(notices.isEmpty)
        platform.handle(update(task(turn: "turn-2", activity: 20, updated: "2026-10-20T10:00:00.100Z")))
        await platform.flush("local")
        XCTAssertEqual(notices.map(\.key), ["complete:turn-2"])
    }

    func testDockBadgeClearsResolvedArchivedAndRemovedHostTasks() async {
        var badges: [Int] = []
        let platform = NativePlatform(sound: { _ in }, badge: { badges.append($0) },
            noticeDelivery: { _, _ in }, viewed: { _, _ in false })
        platform.handle(snapshot([task(status: "waiting_for_input", pending: 1)]))
        await platform.flush("local")
        XCTAssertEqual(badges.last, 1)
        platform.handle(snapshot([task(status: "waiting_for_input", pending: 1)]), hostID: "server-a")
        await platform.flush("server-a")
        XCTAssertEqual(badges.last, 2)
        platform.handle(update(task(status: "waiting_for_input", pending: 1).setting("is_archived", .bool(true))))
        await platform.flush("local")
        XCTAssertEqual(badges.last, 1)
        platform.handle(snapshot([]), hostID: "server-a")
        await platform.flush("server-a")
        XCTAssertEqual(badges.last, 0)
    }

    func testViewedAndDisabledNoticesDoNotReplayWhenPreferencesChange() async {
        var notices: [NativeAttentionNotice] = []
        var viewed = true
        let platform = NativePlatform(sound: { _ in }, badge: { _ in },
            noticeDelivery: { notice, _ in notices.append(notice) }, viewed: { _, _ in viewed })
        platform.handle(snapshot([]))
        platform.handle(update(task()))
        await platform.flush("local")
        viewed = false
        platform.handle(update(task()))
        await platform.flush("local")
        XCTAssertTrue(notices.isEmpty)
        platform.handle(snapshot([], notifications: .object(["enabled": .bool(false)])))
        platform.handle(update(task(turn: "turn-2")))
        await platform.flush("local")
        platform.handle(.object(["event": .object(["type": .string("preferences-updated"),
            "preferences": .object(["notifications": .object(["enabled": .bool(true)])])])]))
        platform.handle(update(task(turn: "turn-2")))
        await platform.flush("local")
        XCTAssertTrue(notices.isEmpty)
    }
}
