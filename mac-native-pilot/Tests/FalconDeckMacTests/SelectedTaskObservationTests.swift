import Foundation
import Observation
import XCTest
@testable import FalconDeckMac

private func observedTask(_ id: String, provider: String = "codex", status: String = "idle") -> JSON {
    .object([
        "id": .string(id), "workspace_id": .string("project"), "title": .string(id),
        "provider": .string(provider), "status": .string(status),
        "updated_at": .string("2026-10-20T08:00:00Z")
    ])
}

private func observedSnapshot(_ tasks: [JSON]) -> JSON {
    .object(["event": .object(["type": .string("snapshot"), "snapshot": .object([
        "workspaces": .array([.object(["id": .string("project"), "path": .string("/tmp/project")])]),
        "threads": .array(tasks), "interactive_requests": .array([])
    ])])])
}

private func observedTaskUpdate(_ task: JSON) -> JSON {
    .object(["thread_id": task["id"], "event": .object(["type": .string("thread-updated"), "thread": task])])
}

private actor SelectedTaskDaemon: DaemonServing {
    func snapshot() async throws -> JSON { .null }
    func events() async throws -> AsyncThrowingStream<JSON, Error> { AsyncThrowingStream { $0.finish() } }
    func disconnect() async {}
    func threadDetail(projectID: String, threadID: String, before: String?) async throws -> JSON {
        // Selection is immediate; these tests exercise event/index updates rather
        // than adopting unrelated metadata from a fabricated detail response.
        .object(["items": .array([]), "has_older": .bool(false)])
    }
    func connectProject(path: String) async throws -> Project { throw PilotError("Unused test operation") }
    func startThread(projectID: String, provider: String?, modelID: String?) async throws -> AgentTask { throw PilotError("Unused test operation") }
    func sendTurn(projectID: String, threadID: String, text: String, userItemID: String?) async throws -> JSON { throw PilotError("Unused test operation") }
    func interrupt(projectID: String, threadID: String) async throws {}
    func respond(projectID: String, requestID: String, response: JSON) async throws {}
    func markRead(projectID: String, threadID: String, readSeq: Int) async throws {}
}

private final class SelectedTaskChanges: @unchecked Sendable {
    var count = 0
}

final class SelectedTaskObservationTests: XCTestCase {
    @MainActor func testUnrelatedTaskUpdatesNotifyNavigationWithoutInvalidatingConversation() async {
        let store = AppStore(client: SelectedTaskDaemon(), readVisibility: { false })
        store.applyEnvelope(observedSnapshot([observedTask("selected"), observedTask("other")]), notifyPlatform: false)
        await store.selectTask("selected")
        let conversation = SelectedTaskChanges(), navigation = SelectedTaskChanges()
        withObservationTracking {
            _ = store.selectedTask
            _ = store.selectedTask?.provider
            _ = store.isRunning
        } onChange: { conversation.count += 1 }
        withObservationTracking { _ = store.tasks } onChange: { navigation.count += 1 }

        let updated = observedTask("other", provider: "claude", status: "running")
            .setting("updated_at", .string("2026-10-20T08:00:01Z"))
            .setting("last_message_preview", .string("Another agent is working"))
        store.applyEnvelope(observedTaskUpdate(updated), notifyPlatform: false)

        XCTAssertEqual(conversation.count, 0)
        XCTAssertEqual(navigation.count, 1)
        XCTAssertEqual(store.tasks.first { $0.id == "other" }?.raw, updated)
        XCTAssertEqual(store.selectedTask?.raw, observedTask("selected"))
        XCTAssertFalse(store.isRunning)
    }

    @MainActor func testSelectedTaskMetadataUpdatesRemainObservable() async {
        let store = AppStore(client: SelectedTaskDaemon(), readVisibility: { false })
        store.applyEnvelope(observedSnapshot([observedTask("selected")]), notifyPlatform: false)
        await store.selectTask("selected")
        let changes = SelectedTaskChanges()
        withObservationTracking { _ = store.selectedTask } onChange: { changes.count += 1 }

        let updated = observedTask("selected", provider: "claude", status: "running")
            .setting("updated_at", .string("2026-10-20T08:00:01Z"))
            .setting("queued_turns", .array([.object(["id": .string("queued"), "text": .string("Follow-up")])]))
        store.applyEnvelope(observedTaskUpdate(updated), notifyPlatform: false)

        XCTAssertEqual(changes.count, 1)
        XCTAssertEqual(store.selectedTask?.raw, updated)
        XCTAssertEqual(store.selectedTask?.provider, "claude")
        XCTAssertTrue(store.isRunning)

        let queueChanges = SelectedTaskChanges()
        withObservationTracking { _ = store.selectedTask } onChange: { queueChanges.count += 1 }
        let emptyQueue = updated.setting("queued_turns", .array([]))
        store.applyEnvelope(observedTaskUpdate(emptyQueue), notifyPlatform: false)
        XCTAssertEqual(queueChanges.count, 1, "Changes beyond title/status must reach conversation panels and actions")
        XCTAssertEqual(store.selectedTask?.raw, emptyQueue)
    }

    @MainActor func testIdenticalMetadataReplacementAndReorderingDoNotInvalidateSelection() async {
        let store = AppStore(client: SelectedTaskDaemon(), readVisibility: { false })
        let selected = observedTask("selected"), other = observedTask("other")
        store.applyEnvelope(observedSnapshot([selected, other]), notifyPlatform: false)
        await store.selectTask("selected")
        let changes = SelectedTaskChanges()
        withObservationTracking { _ = store.selectedTask } onChange: { changes.count += 1 }

        store.applyEnvelope(observedTaskUpdate(selected), notifyPlatform: false)
        store.tasks.reverse()
        store.applyEnvelope(observedSnapshot([other.setting("title", .string("Renamed")), selected]), notifyPlatform: false)

        XCTAssertEqual(changes.count, 0)
        XCTAssertEqual(store.selectedTaskID, "selected")
        XCTAssertEqual(store.selectedTask?.raw, selected)
        XCTAssertEqual(store.tasks.map(\.id), ["other", "selected"])
    }

    @MainActor func testInitialPopulationNavigationAndNewTaskKeepProjectionCurrent() async {
        let store = AppStore(client: SelectedTaskDaemon(), readVisibility: { false })
        XCTAssertNil(store.selectedTask)
        store.applyEnvelope(observedSnapshot([observedTask("first"), observedTask("second", provider: "claude")]), notifyPlatform: false)
        XCTAssertNil(store.selectedTask, "An index must not invent a selected conversation")

        await store.selectTask("first")
        XCTAssertEqual(store.selectedTask?.id, "first")
        let navigation = SelectedTaskChanges()
        withObservationTracking { _ = store.selectedTask } onChange: { navigation.count += 1 }
        await store.selectTask("second")
        XCTAssertEqual(navigation.count, 1)
        XCTAssertEqual(store.selectedTask?.id, "second")
        XCTAssertEqual(store.selectedTask?.provider, "claude")

        let cleared = SelectedTaskChanges()
        withObservationTracking { _ = store.selectedTask } onChange: { cleared.count += 1 }
        store.newTask()
        XCTAssertEqual(cleared.count, 1)
        XCTAssertNil(store.selectedTaskID)
        XCTAssertNil(store.selectedTask)
    }

    @MainActor func testRemovingSelectionAndRepopulatingIndexCannotLeaveStaleMetadata() async {
        let store = AppStore(client: SelectedTaskDaemon(), readVisibility: { false })
        let selected = observedTask("selected"), other = observedTask("other")
        store.applyEnvelope(observedSnapshot([selected, other]), notifyPlatform: false)
        await store.selectTask("selected")
        let removed = SelectedTaskChanges()
        withObservationTracking { _ = store.selectedTask } onChange: { removed.count += 1 }

        store.tasks.removeAll { $0.id == "selected" }
        XCTAssertEqual(removed.count, 1)
        XCTAssertNil(store.selectedTask)
        XCTAssertFalse(store.isRunning)

        let restored = SelectedTaskChanges()
        withObservationTracking { _ = store.selectedTask } onChange: { restored.count += 1 }
        let replacement = selected.setting("title", .string("Restored metadata"))
        store.tasks.append(AgentTask(replacement))
        XCTAssertEqual(restored.count, 1)
        XCTAssertEqual(store.selectedTask?.raw, replacement)

        store.applyEnvelope(observedSnapshot([other]), notifyPlatform: false)
        XCTAssertNil(store.selectedTaskID)
        XCTAssertNil(store.selectedTask)
    }
}
