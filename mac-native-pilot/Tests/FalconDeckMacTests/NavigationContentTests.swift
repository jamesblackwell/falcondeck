import XCTest
@testable import FalconDeckMac

final class NavigationContentTests: XCTestCase {
    func testProjectGroupingUsesOneDisplayOrderForRowsAndPagination() {
        let content = NativeTaskNavigationContent(
            tasks: [task("root"), task("folder"), task("pin", projectPin: true), task("collapsed")],
            folders: [folder("open", members: ["folder", "pin"]), folder("closed", members: ["collapsed"])],
            expandedFolderIDs: ["open"], grouped: true, limit: 2, selectedID: nil)

        XCTAssertEqual(content.count, 4)
        XCTAssertEqual(content.orderedIDs, ["pin", "folder", "root"])
        XCTAssertEqual(content.pinned.map(\.id), ["pin"])
        XCTAssertEqual(content.folders.map(\.count), [1, 1])
        XCTAssertEqual(content.folders[0].tasks.map(\.id), ["folder"])
        XCTAssertTrue(content.folders[1].tasks.isEmpty)
        XCTAssertTrue(content.root.isEmpty)
        XCTAssertEqual(content.page.remainingCount, 1, "Collapsed folders must not consume a visible page")
    }

    func testSelectedGlobalPinBeyondPageStaysInProjectRootWithoutExpandingAllRows() {
        let tasks = (0..<816).map { index in
            task("task-\(index)", globalPin: index == 815)
        }
        let content = NativeTaskNavigationContent(tasks: tasks, folders: [], expandedFolderIDs: [],
            grouped: true, limit: 80, selectedID: "task-815")

        XCTAssertEqual(content.root.count, 81)
        XCTAssertTrue(content.root.contains { $0.id == "task-815" && $0.pinned })
        XCTAssertEqual(content.page.remainingCount, 735)
        XCTAssertEqual(content.pinnedCount, 0, "Global pins remain ordinary members of their project list")
    }

    func testOverlappingFolderMembershipDoesNotRenderDuplicateRows() {
        let content = NativeTaskNavigationContent(tasks: [task("shared"), task("root")],
            folders: [folder("first", members: ["shared"]), folder("second", members: ["shared"])],
            expandedFolderIDs: ["first", "second"], grouped: true, limit: 80, selectedID: "shared")

        XCTAssertEqual(content.orderedIDs, ["shared", "root"])
        XCTAssertEqual(content.folders.map(\.count), [1, 0])
        XCTAssertEqual(content.folders.flatMap(\.tasks).map(\.id), ["shared"])
        XCTAssertEqual(content.page.remainingCount, 0)
    }

    func testArchivedAndNonProjectScopesDoNotApplyProjectGrouping() {
        let content = NativeTaskNavigationContent(tasks: [task("root"), task("pin", projectPin: true)],
            folders: [folder("closed", members: ["root"])], expandedFolderIDs: [],
            grouped: false, limit: 80, selectedID: nil)

        XCTAssertEqual(content.orderedIDs, ["root", "pin"])
        XCTAssertEqual(content.root.map(\.id), ["root", "pin"])
        XCTAssertTrue(content.pinned.isEmpty)
        XCTAssertTrue(content.folders.isEmpty)
    }

    private func task(_ id: String, projectPin: Bool = false, globalPin: Bool = false) -> AgentTask {
        AgentTask(.object(["id": .string(id), "workspace_id": .string("project"),
            "is_pinned_in_project": .bool(projectPin), "is_pinned": .bool(globalPin)]))
    }

    private func folder(_ id: String, members: [String]) -> NativeProjectFolder {
        NativeProjectFolder(raw: .object(["id": .string(id), "thread_ids": .array(members.map(JSON.string))]))
    }
}
