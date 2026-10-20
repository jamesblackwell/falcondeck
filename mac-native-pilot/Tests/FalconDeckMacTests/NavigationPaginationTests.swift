import XCTest
@testable import FalconDeckMac

final class NavigationPaginationTests: XCTestCase {
    private let ids = (0..<816).map { "task-\($0)" }

    func testLargeProjectStartsWithBoundedRowsAndExpandsByOneHundred() {
        let initial = NativeTaskNavigationPage(orderedIDs: ids, limit: NativeTaskNavigationPage.initialLimit, selectedID: nil)
        XCTAssertEqual(initial.includedIDs.count, 80)
        XCTAssertEqual(initial.remainingCount, 736)
        let next = NativeTaskNavigationPage(orderedIDs: ids, limit: initial.nextLimit, selectedID: nil)
        XCTAssertEqual(next.includedIDs.count, 180)
        XCTAssertEqual(next.remainingCount, 636)
    }

    func testNavigationToLastTaskRetainsSelectionWithoutRenderingWholeProject() {
        let page = NativeTaskNavigationPage(orderedIDs: ids, limit: 80, selectedID: "task-815")
        XCTAssertTrue(page.includedIDs.contains("task-815"))
        XCTAssertEqual(page.includedIDs.count, 81)
        XCTAssertEqual(page.remainingCount, 735)
    }

    func testSelectionInsidePageIsNotDuplicatedAndOtherScopeIsNotInserted() {
        let present = NativeTaskNavigationPage(orderedIDs: ids, limit: 80, selectedID: "task-2")
        let otherScope = NativeTaskNavigationPage(orderedIDs: ids, limit: 80, selectedID: "other-project-task")
        XCTAssertEqual(present.includedIDs.count, 80)
        XCTAssertEqual(otherScope.includedIDs.count, 80)
        XCTAssertFalse(otherScope.includedIDs.contains("other-project-task"))
    }

    func testFinalExpansionStopsAtEndAndEmptyScopeHasNoMoreRows() {
        let final = NativeTaskNavigationPage(orderedIDs: ids, limit: 780, selectedID: nil)
        XCTAssertEqual(final.nextLimit, 816)
        let complete = NativeTaskNavigationPage(orderedIDs: ids, limit: final.nextLimit, selectedID: "task-815")
        XCTAssertEqual(complete.remainingCount, 0)
        let empty = NativeTaskNavigationPage(orderedIDs: [], limit: 80, selectedID: "task-815")
        XCTAssertTrue(empty.includedIDs.isEmpty)
        XCTAssertEqual(empty.remainingCount, 0)
    }
}
