import XCTest
@testable import FalconDeckMac

final class NavigationTests: XCTestCase {
    func testPriorityReadingDoesNotDemoteAndNewResponsePromotes() {
        var order = NativeTaskNavigationOrder()
        let unread = navigationTask("unread", date: "02", unread: true)
        let running = navigationTask("running", date: "03", status: "running")
        XCTAssertEqual(order.ordered([running, unread], mode: "priority", scope: "project"), ["unread", "running"])
        let read = navigationTask("unread", date: "02")
        XCTAssertEqual(order.ordered([running, read], mode: "priority", scope: "project"), ["unread", "running"])
        let blocked = navigationTask("running", date: "04", status: "waiting_for_input")
        XCTAssertEqual(order.ordered([read, blocked], mode: "priority", scope: "project"), ["running", "unread"])
    }

    func testPriorityReenteringAndProjectChangeReleaseDeferredDemotion() {
        var order = NativeTaskNavigationOrder()
        let unread = navigationTask("result", date: "01", unread: true)
        let running = navigationTask("working", date: "02", status: "running")
        _ = order.ordered([unread, running], mode: "priority", scope: "project")
        let read = navigationTask("result", date: "01")
        _ = order.ordered([read, running], mode: "alphabetical", scope: "project")
        XCTAssertEqual(order.ordered([read, running], mode: "priority", scope: "project"), ["working", "result"])
        XCTAssertEqual(order.ordered([read, running], mode: "priority", scope: "other-project"), ["working", "result"])
    }

    func testRecencyFreezesStreamingThenSettlesAndPrunesRemovedTasks() {
        var order = NativeTaskNavigationOrder()
        let settled = navigationTask("settled", date: "02")
        let running = navigationTask("running", date: "01", status: "running")
        XCTAssertEqual(order.ordered([running, settled], mode: "last_updated", scope: "p"), ["settled", "running"])
        let streamed = navigationTask("running", date: "99", status: "running")
        XCTAssertEqual(order.ordered([streamed, settled], mode: "last_updated", scope: "p"), ["settled", "running"])
        let done = navigationTask("running", date: "99")
        XCTAssertEqual(order.ordered([done, settled], mode: "last_updated", scope: "p"), ["running", "settled"])
        XCTAssertEqual(order.ordered([settled], mode: "last_updated", scope: "p"), ["settled"])
    }

    func testFilterUsesOnlyItsOwnExtensionAndThreadProjection() {
        let snapshot = extensionSnapshot(views: [
            extensionView(extensionID: "other.extension", viewID: "thread-tags", taskID: "wrong", value: .object(["tagIds": .array([.string("in_review")])])),
            extensionView(viewID: "thread-tags", taskID: "right", value: .object(["tagIds": .array([.string("in_review")])]))
        ])
        let extensions = NativeSidebarExtensions(snapshot)
        let selected: [String: Set<String>] = [NativeSidebarExtensions.stagesID + ":tags": ["in_review"]]
        XCTAssertTrue(extensions.matches(taskID: "right", selections: selected))
        XCTAssertFalse(extensions.matches(taskID: "wrong", selections: selected))
        XCTAssertTrue(extensions.matches(taskID: "wrong", selections: [:]))
    }

    func testDisabledExtensionRetractsFiltersStagesAndPanels() {
        let extensions = NativeSidebarExtensions(extensionSnapshot(enabled: false, views: [
            extensionView(viewID: "tag-index", value: .object(["tags": .array([.object(["id": .string("custom"), "label": .string("Custom"), "color": .string("blue")])])]))
        ]))
        XCTAssertFalse(extensions.stagesEnabled)
        XCTAssertTrue(extensions.stages.isEmpty)
        XCTAssertTrue(extensions.filters.isEmpty)
        XCTAssertTrue(extensions.panels.isEmpty)
        XCTAssertTrue(extensions.matches(taskID: "any", selections: [NativeSidebarExtensions.stagesID + ":tags": ["custom"]]))
    }

    func testCustomStagesAreUsedByBothMarkersAndFilterOptions() {
        let custom: JSON = .object(["id": .string("release"), "label": .string("Ready to release"), "color": .string("green")])
        let extensions = NativeSidebarExtensions(extensionSnapshot(views: [
            extensionView(viewID: "tag-index", value: .object(["tags": .array([custom])])),
            extensionView(viewID: "thread-tags", taskID: "task", value: .object(["tagIds": .array([.string("release")])]))
        ]))
        XCTAssertEqual(extensions.stage(navigationTask("task"))?["id"], .string("release"))
        XCTAssertEqual(extensions.filters.first?.options.first?["value"], .string("release"))
        XCTAssertEqual(extensions.panels.first?.extensionID, NativeSidebarExtensions.stagesID)
    }

    func testUnsafeFilterBindingIsVisibleAsUnsupportedAndDoesNotHideTasks() {
        let filter = NativeSidebarExtensionFilter(extensionID: "example", contribution: .object(["id": .string("unsafe")]), document: filterDocument(path: ["__proto__"]))
        XCTAssertFalse(filter.supported)
        let tooDeep = NativeSidebarExtensionFilter(extensionID: "example", contribution: .null, document: filterDocument(path: Array(repeating: "a", count: 17)))
        XCTAssertFalse(tooDeep.supported)
    }

    func testBoundedForkContextRetainsOpeningAndRecentTextWithExplicitGap() {
        let opening = "OPENING " + String(repeating: "a", count: 500)
        let recent = String(repeating: "z", count: 500) + " RECENT"
        let messages = [Message(.object(["id": .string("one"), "kind": .string("user_message"), "text": .string(opening)])), Message(.object(["id": .string("two"), "kind": .string("assistant_message"), "text": .string(recent)]))]
        let result = NativeTaskActions.boundedContext(messages, limit: 200)
        XCTAssertTrue(result.contains("OPENING"))
        XCTAssertTrue(result.contains("RECENT"))
        XCTAssertTrue(result.contains("[Middle of transcript omitted"))
        XCTAssertLessThanOrEqual(result.count, 200)
    }

    func testEmptyHistoryDoesNotCreateForkContextAndToolEvidenceIsRetained() {
        let message = Message(.object(["id": .string("tool"), "kind": .string("tool_call"), "output": .string("private tool output")]))
        XCTAssertEqual(NativeTaskActions.boundedContext([]), "")
        XCTAssertTrue(NativeTaskActions.boundedContext([message]).contains("private tool output"))
    }
}

private func navigationTask(_ id: String, date: String = "01", status: String = "idle", unread: Bool = false) -> AgentTask {
    AgentTask(.object(["id": .string(id), "workspace_id": .string("project"), "title": .string(id), "status": .string(status), "updated_at": .string(date), "attention": .object(["unread": .bool(unread)])]))
}

private func filterDocument(path: [String] = ["tagIds"]) -> JSON {
    .object(["version": .number(1), "root": .object([
        "type": .string("select"), "id": .string("stages"), "label": .string("Stage"), "multiple": .bool(true),
        "options": .array([.object(["value": .string("in_review"), "label": .string("In review")])]),
        "binding": .object(["view": .string("thread-tags"), "operator": .string("includes_any"), "path": .array(path.map(JSON.string))])
    ])])
}

private func extensionSnapshot(enabled: Bool = true, views: [JSON]) -> JSON {
    .object(["catalog": .array([.object([
        "id": .string(NativeSidebarExtensions.stagesID), "enabled": .bool(enabled), "name": .string("Kanban"),
        "contributes": .object([
            "sidebarFilters": .array([.object(["id": .string("tags"), "title": .string("Stages"), "view": .string("tag-index"), "ui": filterDocument()])]),
            "panels": .array([.object(["id": .string("board"), "title": .string("Kanban"), "icon": .string("kanban")])])
        ])
    ])]), "views": .array(views)])
}

private func extensionView(extensionID: String = NativeSidebarExtensions.stagesID, viewID: String, taskID: String? = nil, value: JSON) -> JSON {
    .object(["extension_id": .string(extensionID), "view_id": .string(viewID), "scope": taskID.map { .object(["kind": .string("thread"), "id": .string($0)]) } ?? .null, "value": value])
}
