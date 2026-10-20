import Sparkle
import XCTest
@testable import FalconDeckMac

@MainActor final class NativeUpdateControllerTests: XCTestCase {
    func testRestartWaitsForActiveTasksAndConsumesInstallCallbackOnce() async {
        var active = 1
        var replies: [SPUUserUpdateChoice] = []
        let controller = NativeUpdateController(startUpdater: false, activeThreadCount: { active })
        controller.showReady { replies.append($0) }
        await controller.restart()
        XCTAssertTrue(replies.isEmpty)
        XCTAssertTrue(controller.error?.contains("1 task is") == true)
        active = 0
        await controller.restart()
        await controller.restart()
        XCTAssertEqual(replies, [.install])
    }

    func testDismissalRemovesTheRestartActionAndAllTerminationCallbacks() async {
        var retries = 0
        let controller = NativeUpdateController(startUpdater: false, activeThreadCount: { 0 })
        controller.showInstallingUpdate(withApplicationTerminated: false) { retries += 1 }
        controller.dismissUpdateInstallation()
        XCTAssertEqual(controller.state, "idle")
        await controller.restart()
        XCTAssertEqual(retries, 0)
        controller.showInstallingUpdate(withApplicationTerminated: true) { retries += 1 }
        await controller.restart()
        XCTAssertEqual(retries, 0)
    }

    func testDismissedCycleCannotInstallANewerCycleAfterAwaitingTaskCount() async {
        var continuation: CheckedContinuation<Int, Never>?
        var oldReplies = 0, newReplies = 0
        let controller = NativeUpdateController(startUpdater: false, activeThreadCount: {
            await withCheckedContinuation { continuation = $0 }
        })
        controller.showReady { _ in oldReplies += 1 }
        let restart = Task { await controller.restart() }
        while continuation == nil { await Task.yield() }
        controller.dismissUpdateInstallation()
        controller.showReady { _ in newReplies += 1 }
        continuation?.resume(returning: 0)
        await restart.value
        XCTAssertEqual(oldReplies, 0)
        XCTAssertEqual(newReplies, 0)
        XCTAssertEqual(controller.state, "installed")
    }

    func testExtractionProgressRejectsNonFiniteAndClampsOutOfRangeValues() {
        let controller = NativeUpdateController(startUpdater: false)
        controller.showExtractionReceivedProgress(.nan)
        XCTAssertNil(controller.progress)
        controller.showExtractionReceivedProgress(-1)
        XCTAssertEqual(controller.progress, 0)
        controller.showExtractionReceivedProgress(2)
        XCTAssertEqual(controller.progress, 1)
    }
}
