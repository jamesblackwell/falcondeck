import XCTest
@testable import FalconDeckNative

@MainActor final class TaskLiveActivityTests: XCTestCase {
    private let pairing = String(repeating: "a", count: 64)
    private let now = Date(timeIntervalSince1970: 1_700_000_000)
    private func task(_ status: String = "running", id: String = "thread", title: String = "Polish the native app") -> AgentTask {
        AgentTask(.object(["id": .string(id), "workspace_id": .string("workspace"), "title": .string(title), "status": .string(status)]))
    }
    func testWorkingInputAndCompletionUseOneActivityWithBoundedMetadata() async throws {
        let client = TaskActivityFixture(), activity = TaskLiveActivity(client: client)
        try activity.start(task: task(title: String(repeating: "🦅", count: 1000)), project: String(repeating: "p", count: 200), pairing: pairing, now: now)
        try activity.start(task: task(), project: "Project", pairing: pairing, now: now)
        XCTAssertEqual(client.starts, 1)
        XCTAssertEqual(activity.record?.state.title.count, 160)
        XCTAssertEqual(activity.record?.state.project.count, 80)
        activity.refresh(task: task("waiting_for_input"), project: "Project", connected: true, authoritative: true, now: now.addingTimeInterval(2))
        await activity.settle()
        XCTAssertEqual(client.records.first?.state.phase, .needsInput)
        activity.refresh(task: task("idle"), project: "Project", connected: true, authoritative: true, now: now.addingTimeInterval(5))
        await activity.settle()
        XCTAssertNil(activity.record)
        XCTAssertEqual(client.endings.last?.state?.phase, .completed)
        XCTAssertEqual(client.endings.last?.dismissAt, now.addingTimeInterval(605))
    }
    func testCachedIdleCannotFinishARestoredRunningActivityAndMissingCompactRowIsNotDeletion() async throws {
        let client = TaskActivityFixture(), activity = TaskLiveActivity(client: client)
        try activity.start(task: task(), project: "Project", pairing: pairing, now: now)
        activity.refresh(task: task("idle"), project: "Cached", connected: false, authoritative: false, now: now.addingTimeInterval(100))
        await activity.settle()
        XCTAssertEqual(activity.record?.state.phase, .working)
        XCTAssertEqual(activity.record?.state.updatedAt, now)
        XCTAssertEqual(activity.record?.state.connected, false)
        activity.refresh(task: nil, project: nil, connected: true, authoritative: true, now: now.addingTimeInterval(150))
        await activity.settle()
        XCTAssertTrue(activity.isTracking("thread"))
        XCTAssertTrue(client.endings.isEmpty)
        XCTAssertEqual(client.updates.count, 1)
    }
    func testStoppedOrDismissedActivityNeverRestartsOnSync() async throws {
        let client = TaskActivityFixture(), activity = TaskLiveActivity(client: client)
        try activity.start(task: task(), project: "Project", pairing: pairing, now: now)
        client.records = [] // The user swiped the card away.
        activity.refresh(task: task(), project: "Project", connected: true, authoritative: true)
        XCTAssertNil(activity.record)
        activity.refresh(task: task("waiting_for_input"), project: "Project", connected: true, authoritative: true)
        XCTAssertEqual(client.starts, 1)
        try activity.start(task: task(), project: "Project", pairing: pairing, now: now)
        activity.refresh(task: task("waiting_for_input"), project: "Project", connected: true, authoritative: true)
        activity.stop()
        await activity.settle()
        XCTAssertNil(activity.record)
        XCTAssertTrue(client.records.isEmpty)
        XCTAssertTrue(client.updates.isEmpty, "A queued update must not resurrect a stopped activity")
    }
    func testRestoreKeepsNewestMatchingPairingAndEndsOrphans() async throws {
        let client = TaskActivityFixture()
        let original = TaskLiveActivity(client: client)
        try original.start(task: task(), project: "Project", pairing: pairing, now: now)
        var other = try XCTUnwrap(client.records.first)
        other = TaskActivityRecord(id: "orphan", attributes: .init(pairing: String(repeating: "b", count: 64), workspaceID: "workspace", threadID: "other"), state: other.state)
        client.records.append(other)
        let restored = TaskLiveActivity(client: client)
        restored.restore(pairing: pairing); await restored.settle()
        XCTAssertEqual(restored.record?.attributes.threadID, "thread")
        XCTAssertEqual(client.records.count, 1)
        restored.restore(pairing: nil); await restored.settle()
        XCTAssertNil(restored.record); XCTAssertTrue(client.records.isEmpty)
    }
    func testTokenStreamingDoesNotUpdateActivityKitAndFailuresPreserveCurrentTracking() async throws {
        let client = TaskActivityFixture(), activity = TaskLiveActivity(client: client)
        try activity.start(task: task(), project: "Project", pairing: pairing, now: now)
        for i in 0..<300 {
            activity.refresh(task: task(), project: "Project", connected: true, authoritative: true, now: now.addingTimeInterval(Double(i) / 100))
        }
        await activity.settle()
        XCTAssertTrue(client.updates.isEmpty)
        XCTAssertEqual(client.activityReads, 0, "Unchanged token bursts must not query ActivityKit")
        client.failStart = true
        XCTAssertThrowsError(try activity.start(task: task(id: "other"), project: "Project", pairing: pairing, now: now))
        XCTAssertTrue(activity.isTracking("thread"))
        XCTAssertTrue(client.endings.isEmpty)
    }
    func testDeepLinkRoundTripsEscapingAndRejectsDuplicatesAndOtherSchemes() throws {
        let attributes = NativeTaskAttributes(pairing: pairing, workspaceID: "project & /?", threadID: "thread=🦅")
        let url = try XCTUnwrap(attributes.url)
        XCTAssertEqual(NativeTaskAttributes(url: url), attributes)
        XCTAssertNil(NativeTaskAttributes(url: URL(string: url.absoluteString.replacingOccurrences(of: "falcondeck-native:", with: "https:"))!))
        XCTAssertNil(NativeTaskAttributes(url: URL(string: url.absoluteString + "&thread=other")!))
        XCTAssertNil(NativeTaskAttributes(url: URL(string: "falcondeck-native://task?pairing=x&workspace=w&thread=t")!))
    }
    func testEndedSystemActivityIsNotAdoptedAndIsClearedWhenForgetting() async throws {
        let client = TaskActivityFixture(), activity = TaskLiveActivity(client: client)
        try activity.start(task: task(), project: "Project", pairing: pairing, now: now)
        client.records[0].ended = true
        activity.restore(pairing: pairing); await activity.settle()
        XCTAssertNil(activity.record); XCTAssertTrue(client.records.isEmpty)
    }
    func testActivityPayloadFitsWithExtendedEmojiAndEscapedText() throws {
        let client = TaskActivityFixture(), activity = TaskLiveActivity(client: client)
        try activity.start(task: task(title: String(repeating: "👨‍👩‍👧‍👦", count: 160)), project: String(repeating: "\u{01}", count: 80), pairing: pairing, now: now)
        let record = try XCTUnwrap(activity.record)
        let attributes = try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(record.attributes))
        let state = try JSONDecoder().decode(JSON.self, from: JSONEncoder().encode(record.state))
        let bytes = try JSON.object(["attributes": attributes, "content-state": state]).data().count
        XCTAssertLessThan(bytes, 4096)
        XCTAssertTrue(record.state.title.allSatisfy { $0 == "👨‍👩‍👧‍👦" }, "Do not split emoji clusters")
        XCTAssertThrowsError(try activity.start(task: task(id: String(repeating: "\"", count: 1000)), project: "Project", pairing: pairing, now: now))
        XCTAssertEqual(client.starts, 1)
    }
    func testTaskTapRejectsAnotherPairingAndOnlyReadsTheMatchingThread() async throws {
        let session = SavedSession(relay: URL(string: "https://example.test")!, sessionID: "session", deviceID: "device", token: "fixture", secret: Data(repeating: 7, count: 32), daemonKey: "fixture", daemonIdentity: "fixture")
        let relay = TaskActivityRoutingRelay(), model = AppModel.testing(relay: relay, sessionLoader: { session })
        model.connected = true; model.tasks = [task()]
        let wrong = NativeTaskAttributes(pairing: pairing, workspaceID: "workspace", threadID: "thread")
        await model.openTaskActivity(try XCTUnwrap(wrong.url))
        XCTAssertEqual(model.selection, .projects)
        let rejectedReads = await relay.reads; XCTAssertEqual(rejectedReads, 0)
        let correct = NativeTaskAttributes(pairing: TaskLiveActivity.pairingKey(session), workspaceID: "workspace", threadID: "thread")
        await model.openTaskActivity(try XCTUnwrap(correct.url))
        XCTAssertEqual(model.selection, .task("thread"))
        let reads = await relay.reads, writes = await relay.writes
        XCTAssertEqual(reads, 1); XCTAssertEqual(writes, 0)
    }
}

@MainActor private final class TaskActivityFixture: TaskActivityServing {
    var enabled = true
    var records: [TaskActivityRecord] = []
    var activityReads = 0
    var activities: [TaskActivityRecord] { activityReads += 1; return records }
    var starts = 0
    var failStart = false
    var updates: [NativeTaskAttributes.ContentState] = []
    var endings: [(state: NativeTaskAttributes.ContentState?, dismissAt: Date?)] = []
    func start(_ attributes: NativeTaskAttributes, state: NativeTaskAttributes.ContentState) throws -> String {
        if failStart { throw PilotError("Not authorized") }
        starts += 1; let id = String(starts)
        records.append(TaskActivityRecord(id: id, attributes: attributes, state: state)); return id
    }
    func update(_ id: String, state: NativeTaskAttributes.ContentState) async {
        updates.append(state)
        if let index = records.firstIndex(where: { $0.id == id }) { records[index].state = state }
    }
    func end(_ id: String, state: NativeTaskAttributes.ContentState?, dismissAt: Date?) async {
        endings.append((state, dismissAt)); records.removeAll { $0.id == id }
    }
}

private actor TaskActivityRoutingRelay: RelayServing {
    var reads = 0, writes = 0
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { reads += 1; return .object(["thread": task.raw]) }
    func call(_ method: String, params: JSON) -> JSON { writes += 1; return .null }
}
