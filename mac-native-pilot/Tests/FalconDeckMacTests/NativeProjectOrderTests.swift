import XCTest
@testable import FalconDeckMac

final class NativeProjectOrderTests: XCTestCase {
    func testHostSlotsFollowEachHostsCurrentAuthoritativeOrder() {
        XCTAssertEqual(NativeProjectOrder.interleave(
            authoritative: ["l2", "l1", "remote:a:r2", "remote:a:r1"],
            slots: ["remote:a:r1", "l1", "remote:a:r2", "l2"]
        ), ["remote:a:r2", "l2", "remote:a:r1", "l1"])
    }

    func testAbsentHostDoesNotLeaveGhostsAndReturnsToItsSavedSlots() {
        let slots = ["remote:a:r1", "l1", "remote:a:r2", "l2"]
        XCTAssertEqual(NativeProjectOrder.interleave(authoritative: ["l2", "l1"], slots: slots), ["l2", "l1"])
        XCTAssertEqual(NativeProjectOrder.interleave(
            authoritative: ["l2", "l1", "remote:a:r2", "remote:a:r1"], slots: slots
        ), ["remote:a:r2", "l2", "remote:a:r1", "l1"])
    }

    func testStaleProjectSlotStillRepresentsItsHost() {
        XCTAssertEqual(NativeProjectOrder.interleave(
            authoritative: ["l1", "l2", "remote:a:new"], slots: ["l1", "remote:a:removed", "l2"]
        ), ["l1", "remote:a:new", "l2"])
    }

    func testUnrepresentedHostsAndExtraProjectsAppendInAuthoritativeOrder() {
        XCTAssertEqual(NativeProjectOrder.interleave(
            authoritative: ["l2", "l1", "remote:b:b1", "remote:a:r2", "remote:a:r1", "remote:a:r3"],
            slots: ["remote:a:r1", "l1", "remote:a:r2", "l2"]
        ), ["remote:a:r2", "l2", "remote:a:r1", "l1", "remote:b:b1", "remote:a:r3"])
    }

    func testDuplicateProjectsDoNotCreateDuplicateRowsOrExtraHostSlots() {
        XCTAssertEqual(NativeProjectOrder.interleave(
            authoritative: ["l2", "l1", "l2", "remote:a:r2", "remote:a:r1", "remote:a:r2"],
            slots: ["remote:a:r1", "l1", "remote:a:r1", "l1", "remote:a:r2", "l2"]
        ), ["remote:a:r2", "l2", "remote:a:r1", "l1"])
    }

    func testEmptyInputsAndUnsavedOrder() {
        XCTAssertEqual(NativeProjectOrder.interleave(authoritative: [], slots: ["l1", "remote:a:r1"]), [])
        XCTAssertEqual(NativeProjectOrder.interleave(authoritative: ["l1", "remote:a:r1", "l1"], slots: []), ["l1", "remote:a:r1"])
        XCTAssertEqual(NativeProjectOrder.interleave(authoritative: ["", "l1", ""], slots: [""]), ["l1"])
    }

    func testDifferentRemoteHostsKeepIndependentQueues() {
        XCTAssertEqual(NativeProjectOrder.interleave(
            authoritative: ["l2", "l1", "remote:a:a2", "remote:a:a1", "remote:b:b2", "remote:b:b1"],
            slots: ["remote:b:b1", "remote:a:a1", "l1", "remote:b:b2", "l2", "remote:a:a2"]
        ), ["remote:b:b2", "remote:a:a2", "l2", "remote:b:b1", "l1", "remote:a:a1"])
    }

    func testUpdatingVisibleOrderPreservesUnavailableHostSlots() {
        XCTAssertEqual(NativeProjectOrder.updatingSlots(
            previous: ["remote:a:r1", "l1", "l2"], visibleOrder: ["l2", "l1"], availableHosts: ["local"]
        ), ["remote:a:r1", "l2", "l1"])
    }

    func testUpdatingSlotsFillsAvailablePositionsThenAppendsNewRows() {
        XCTAssertEqual(NativeProjectOrder.updatingSlots(
            previous: ["l1", "remote:a:r1", "l2", "remote:a:r2"],
            visibleOrder: ["remote:b:b1", "l2", "l1", "remote:b:b2"], availableHosts: ["local", "b"]
        ), ["remote:b:b1", "remote:a:r1", "l2", "remote:a:r2", "l1", "remote:b:b2"])
    }

    func testUpdatingSlotsRetiresRemovedProjectsOnlyOnAvailableHosts() {
        XCTAssertEqual(NativeProjectOrder.updatingSlots(
            previous: ["remote:a:removed", "local-removed", "l1", "remote:b:offline"],
            visibleOrder: ["l1"], availableHosts: ["local", "a"]
        ), ["l1", "remote:b:offline"])
    }

    func testUpdatingSlotsDeduplicatesBothInputsAndPreservedRows() {
        XCTAssertEqual(NativeProjectOrder.updatingSlots(
            previous: ["remote:a:r1", "l1", "remote:a:r1", "l1", "l2"],
            visibleOrder: ["l2", "l2", "l1", "remote:a:r1"], availableHosts: ["local"]
        ), ["remote:a:r1", "l2", "l1"])
        XCTAssertEqual(NativeProjectOrder.updatingSlots(
            previous: ["l1", "remote:a:r1"], visibleOrder: ["remote:a:r1", "l1"], availableHosts: ["local"]
        ), ["l1", "remote:a:r1"])
    }

    func testUpdatingSlotsHandlesEmptyOrEntirelyUnavailableLists() {
        XCTAssertEqual(NativeProjectOrder.updatingSlots(previous: [], visibleOrder: ["l2", "", "l1", "l2"], availableHosts: ["local"]), ["l2", "l1"])
        XCTAssertEqual(NativeProjectOrder.updatingSlots(previous: ["l1", "remote:a:r1"], visibleOrder: [], availableHosts: []), ["l1", "remote:a:r1"])
        XCTAssertEqual(NativeProjectOrder.updatingSlots(previous: ["l1", "remote:a:r1"], visibleOrder: [], availableHosts: ["local", "a"]), [])
    }

    func testHostReturningAfterAnotherHostReordersRecoversItsPositions() {
        let saved = NativeProjectOrder.updatingSlots(
            previous: ["remote:a:r1", "l1", "remote:a:r2", "l2"], visibleOrder: ["l2", "l1"], availableHosts: ["local"]
        )
        XCTAssertEqual(NativeProjectOrder.interleave(
            authoritative: ["l2", "l1", "remote:a:r2", "remote:a:r1"], slots: saved
        ), ["remote:a:r2", "l2", "remote:a:r1", "l1"])
    }
}
