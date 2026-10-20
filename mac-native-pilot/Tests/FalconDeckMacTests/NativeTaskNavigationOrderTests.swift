import XCTest
@testable import FalconDeckMac

final class NativeTaskNavigationOrderTests: XCTestCase {
    func testAttentionChangesInvalidateOrderWithoutStatusOrTimestampChanges() {
        let task = orderTask("task", attention: .object([:]))
        let waiting = orderTask("task", attention: .object(["pending_question_count": .number(1)]))
        XCTAssertNotEqual(NativeTaskNavigationOrder.key(task), NativeTaskNavigationOrder.key(waiting))
        var ordering = NativeTaskNavigationOrder()
        let unread = orderTask("result", attention: .object(["unread": .bool(true)]))
        XCTAssertEqual(ordering.ordered([task, unread], mode: "priority", scope: "p"), ["result", "task"])
        XCTAssertEqual(ordering.ordered([waiting, unread], mode: "priority", scope: "p"), ["task", "result"])
    }

    func testStreamingPreviewDoesNotInvalidateOrder() {
        let task = orderTask("task", status: "running", updatedAt: "01")
        let streamed = AgentTask(task.raw.setting("updated_at", .string("99")).setting("last_message_preview", .string("More tokens")))
        XCTAssertEqual(NativeTaskNavigationOrder.key(task), NativeTaskNavigationOrder.key(streamed))
    }

    func testFailureWithStalePendingRequestUsesErrorPriority() {
        let failed = orderTask("failed", status: "error", attention: .object([
            "unread": .bool(true), "pending_approval_count": .number(1)
        ]))
        let waiting = orderTask("waiting", attention: .object(["pending_question_count": .number(1)]))
        XCTAssertEqual(NativeTaskNavigationOrder.rank(failed), 1)
        var ordering = NativeTaskNavigationOrder()
        XCTAssertEqual(ordering.ordered([failed, waiting], mode: "priority", scope: "p"), ["waiting", "failed"])
    }

    func testReadFailureWithStalePendingRequestHasNoAttentionPriority() {
        XCTAssertEqual(NativeTaskNavigationOrder.rank(orderTask("failed", status: "error", attention: .object([
            "pending_approval_count": .number(1)
        ]))), 4)
    }

    func testUnreadBackgroundWorkKeepsWorkingPriorityUntilItFinishes() {
        let working = orderTask("working", attention: .object([
            "unread": .bool(true), "background_task_count": .number(1)
        ]))
        XCTAssertEqual(NativeTaskNavigationOrder.rank(working), 3)
        let completed = orderTask("working", attention: .object(["unread": .bool(true)]))
        XCTAssertNotEqual(NativeTaskNavigationOrder.key(working), NativeTaskNavigationOrder.key(completed))
        XCTAssertEqual(NativeTaskNavigationOrder.rank(completed), 2)
    }
}

private func orderTask(_ id: String, status: String = "idle", updatedAt: String = "01", attention: JSON = .object([:])) -> AgentTask {
    AgentTask(.object([
        "id": .string(id), "workspace_id": .string("project"), "title": .string(id),
        "status": .string(status), "updated_at": .string(updatedAt), "attention": attention
    ]))
}
