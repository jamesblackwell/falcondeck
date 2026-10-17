import XCTest
@testable import FalconDeckNative

private actor AutomationRelay: RelayServing {
    var calls: [(String, JSON)] = []
    var response: JSON
    init(_ response: JSON) { self.response = response }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { true }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) -> JSON { calls.append((method, params)); return response }
    func requests() -> [(String, JSON)] { calls }
}

@MainActor final class AutomationTests: XCTestCase {
    func testOlderRunHistoryCannotReplaceANewerRefresh() async throws {
        let relay = RunHistoryRelay(), model = AppModel.testing(relay: relay)
        let first = Task { try await model.automations.loadRuns("fixture", model: model) }
        await relay.waitForFirst()
        try await model.automations.loadRuns("fixture", model: model)
        await relay.finishFirst(); try await first.value
        XCTAssertEqual(model.automations.runs["fixture"]?.first?["id"].string, "new")
    }
    func testLateListCannotUndoAPauseOrResurrectADeletedAutomation() async throws {
        for deleting in [false, true] {
            let relay = AutomationRaceRelay(deleting: deleting), model = AppModel.testing(relay: relay)
            let store = model.automations
            store.visible = 1; store.rows = [NativeAutomation(raw: AutomationRaceRelay.original)]
            let refresh = Task { await store.refresh(model: model) }
            await relay.waitForRead()
            try await store.execute(deleting ? "automation.delete" : "automation.pause", arguments: .object(["automation_id": .string("fixture")]), revision: 1, model: model)
            await relay.finishRead()
            await refresh.value
            if deleting { XCTAssertTrue(store.rows.isEmpty, "A late list must not resurrect a deleted automation") }
            else { XCTAssertEqual(store.rows.first?.revision, 2); XCTAssertFalse(store.rows.first?.enabled ?? true) }
            // A control change during an in-flight list must trigger another read.
            for _ in 0..<100 {
                if await relay.reads >= 2 { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            let reads = await relay.reads
            XCTAssertEqual(reads, 2)
            store.reset()
        }
    }
    private func validDraft() -> AutomationDraft {
        var draft = AutomationDraft(workspacePath: "/work/project")
        draft.name = "Daily check"; draft.instruction = "Check the tests"
        return draft
    }
    func testEditingAnIntervalPreservesItsAnchorAndUnexposedTargetSettings() throws {
        var original = try validDraft().arguments(includeTrigger: true)
        original = original.setting("trigger", .object(["kind": .string("interval"), "every_seconds": .number(3600), "anchor_at": .string("2026-10-01T10:00:00Z")]))
        original = original.setting("target", original["target"].setting("reasoning_effort", .string("high")))
        var draft = AutomationDraft(definition: original)
        draft.name = "Renamed"
        let patch = try draft.arguments(includeTrigger: false)
        XCTAssertEqual(patch["trigger"], .null)
        XCTAssertEqual(patch["target"]["reasoning_effort"].string, "high")
        XCTAssertEqual(try draft.arguments(includeTrigger: true)["trigger"]["anchor_at"].string, "2026-10-01T10:00:00Z")
        draft.provider = "claude"
        XCTAssertEqual(try draft.arguments(includeTrigger: false)["target"]["reasoning_effort"], .null)
    }
    func testChangingPermissionsRemovesThePreviousApprovalPolicy() throws {
        var original = try validDraft().arguments(includeTrigger: true)
        original = original.setting("target", original["target"].setting("permission_mode", .string("never")).setting("approval_policy", .string("never")))
        var draft = AutomationDraft(definition: original)
        draft.permissionMode = "default"
        XCTAssertEqual(try draft.arguments(includeTrigger: false)["target"]["approval_policy"].string, "on-request")
        draft.permissionMode = ""
        XCTAssertEqual(try draft.arguments(includeTrigger: false)["target"]["approval_policy"], .null)
    }
    func testInvalidSchedulesAndMissingExistingTasksCannotBeSubmitted() throws {
        var draft = validDraft()
        draft.scheduleKind = "interval"
        for invalid in ["59", "1.5", "9007199254740992", "NaN"] {
            draft.everySeconds = invalid
            XCTAssertThrowsError(try draft.arguments(includeTrigger: true))
        }
        draft.everySeconds = "60"; draft.threadKind = "existing"
        XCTAssertThrowsError(try draft.arguments(includeTrigger: true))
        draft.threadID = "task"; XCTAssertNoThrow(try draft.arguments(includeTrigger: true))
    }
    func testControlMutationsCarryRevisionAndUniqueIdempotencyKeys() async throws {
        let relay = AutomationRelay(.object(["ok": .bool(true), "data": .null]))
        let model = AppModel.testing(relay: relay)
        for _ in 0..<2 {
            try await model.automations.execute("automation.pause", arguments: .object(["automation_id": .string("a")]), revision: 7, model: model)
        }
        let calls = await relay.requests()
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].1["expected_revision"].int, 7)
        XCTAssertNotEqual(calls[0].1["idempotency_key"], calls[1].1["idempotency_key"])
    }
    func testControlErrorsAreNotTreatedAsSuccessfulSaves() async {
        let relay = AutomationRelay(.object(["ok": .bool(false), "error": .object(["message": .string("Not allowed")])]))
        let model = AppModel.testing(relay: relay)
        do {
            try await model.automations.execute("automation.create", arguments: .null, model: model)
            XCTFail("Expected a control error")
        } catch { XCTAssertEqual(error.localizedDescription, "Not allowed") }
        XCTAssertTrue(model.automations.rows.isEmpty)
    }
    func testPreferencePatchesRetainSiblingValuesAndReplaceArrays() {
        let original = JSON.object(["conversation": .object(["auto_expand": .object(["errors": .bool(true), "approvals": .bool(true)])]), "workspace_order": .array([.string("a"), .string("b")])])
        let merged = original.merging(.object(["conversation": .object(["auto_expand": .object(["errors": .bool(false)])]), "workspace_order": .array([.string("b")])]))
        XCTAssertTrue(merged["conversation"]["auto_expand"]["approvals"].bool)
        XCTAssertFalse(merged["conversation"]["auto_expand"]["errors"].bool)
        XCTAssertEqual(merged["workspace_order"].array, [.string("b")])
    }
}

private actor RunHistoryRelay: RelayServing {
    private var pending: CheckedContinuation<JSON, Never>?
    private var ready: CheckedContinuation<Void, Never>?
    private var reads = 0
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async -> JSON {
        reads += 1
        if reads == 1 { return await withCheckedContinuation { pending = $0; ready?.resume(); ready = nil } }
        return .object(["data": .array([.object(["id": .string("new")])])])
    }
    func waitForFirst() async { if pending == nil { await withCheckedContinuation { ready = $0 } } }
    func finishFirst() { pending?.resume(returning: .object(["data": .array([.object(["id": .string("old")])])])); pending = nil }
}

private actor AutomationRaceRelay: RelayServing {
    static let original = JSON.object(["id": .string("fixture"), "revision": .number(1), "state": .string("enabled"), "target": .object([:])])
    private let deleting: Bool
    private var pending: CheckedContinuation<JSON, Never>?
    private var ready: CheckedContinuation<Void, Never>?
    private(set) var reads = 0
    init(deleting: Bool) { self.deleting = deleting }
    func events() -> AsyncStream<RelayUpdate> { AsyncStream { $0.finish() } }
    func pair(_ input: PairingInput, connectionID: UUID) { }
    func restore(connectionID: UUID) -> Bool { false }
    func disconnect(forget: Bool) { }
    func refresh() { }
    func detail(task: AgentTask, before: String?) -> JSON { .null }
    func call(_ method: String, params: JSON) async -> JSON {
        if method == "control.execute" { return .object(["ok": .bool(true), "data": deleting ? .null : Self.original.setting("revision", .number(2)).setting("state", .string("paused"))]) }
        guard params["resource"].string == "automations" else { return .object(["data": .object([:])]) }
        reads += 1
        if reads == 1 { return await withCheckedContinuation { pending = $0; ready?.resume(); ready = nil } }
        return .object(["data": .array(deleting ? [] : [Self.original.setting("revision", .number(2)).setting("state", .string("paused"))])])
    }
    func waitForRead() async { if pending == nil { await withCheckedContinuation { ready = $0 } } }
    func finishRead() { pending?.resume(returning: .object(["data": .array([Self.original])])); pending = nil }
}
