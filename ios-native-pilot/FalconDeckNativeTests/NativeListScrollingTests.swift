import XCTest
import UIKit
@testable import FalconDeckNative

@MainActor final class NativeListScrollingTests: XCTestCase {
    private final class GestureScrollView: UIScrollView {
        var simulatedTracking = false, simulatedDragging = false, simulatedDeceleration = false
        override var isTracking: Bool { simulatedTracking }
        override var isDragging: Bool { simulatedDragging }
        override var isDecelerating: Bool { simulatedDeceleration }
    }
    private func viewport(in window: UIWindow) -> UIScrollView {
        let view = UIScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        view.contentSize = CGSize(width: 320, height: 1_000)
        window.addSubview(view)
        return view
    }
    // Task.yield can immediately resume this same test under optimization.
    // Suspend so the queued main-actor scroll also gets an executor turn.
    private func settle() async { try? await Task.sleep(for: .milliseconds(25)) }
    func testPendingScrollUsesCurrentLayoutAfterRowsAreReplaced() async {
        let window = UIWindow()
        let view = viewport(in: window)
        let scrolling = NativeListScrolling(); scrolling.attach(view); scrolling.setActive(true)
        scrolling.bottom(animated: false)
        view.contentSize.height = 100
        await settle()
        XCTAssertEqual(view.contentOffset.y, 0)
        view.contentSize.height = 1_800
        scrolling.bottom(animated: false)
        await settle()
        XCTAssertEqual(view.contentOffset.y, 1_320)
    }
    func testDisappearingConversationCancelsItsQueuedScroll() async {
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = viewport(in: window)
        scrolling.attach(view); scrolling.setActive(true)
        scrolling.bottom(animated: false)
        scrolling.setActive(false)
        await settle()
        XCTAssertEqual(view.contentOffset.y, 0)
    }
    func testPrependAnchorKeepsPositionAndCannotScrollAReplacementList() async {
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = viewport(in: window)
        scrolling.attach(view); scrolling.setActive(true)
        view.contentOffset.y = 200
        let row = UIView(frame: CGRect(x: 0, y: 200, width: 320, height: 100))
        view.addSubview(row); scrolling.register(row, id: "reading")
        let anchor = scrolling.readingAnchor()!
        view.contentSize.height += 500 // 300 above the reader; 200 live points below.
        row.frame.origin.y += 300
        scrolling.restore(anchor)
        await settle()
        XCTAssertEqual(view.contentOffset.y, 500)
        let replacement = viewport(in: window)
        scrolling.attach(replacement)
        scrolling.restore(anchor)
        await settle()
        XCTAssertEqual(replacement.contentOffset.y, 0)
    }
    func testOpeningARowCancelsTheQueuedBottomRequest() async {
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = viewport(in: window)
        scrolling.attach(view); scrolling.setActive(true)
        scrolling.bottom(animated: false)
        scrolling.cancel()
        await settle()
        XCTAssertEqual(view.contentOffset.y, 0)
    }
    func testHistoryAnchorDoesNotUndoANewerReadingGesture() async throws {
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = viewport(in: window)
        scrolling.attach(view); scrolling.setActive(true); view.contentOffset.y = 200
        let row = UIView(frame: CGRect(x: 0, y: 200, width: 320, height: 100))
        view.addSubview(row); scrolling.register(row, id: "reading")
        let anchor = try XCTUnwrap(scrolling.readingAnchor())
        scrolling.cancel() // The reader drags elsewhere while history is loading.
        view.contentOffset.y = 400; row.frame.origin.y += 300; view.contentSize.height += 300
        scrolling.restore(anchor)
        await settle()
        XCTAssertEqual(view.contentOffset.y, 400)
    }
    func testAReadingGestureWinsOverAnAlreadyQueuedBottomRequest() async {
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = GestureScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        window.addSubview(view); view.contentSize = CGSize(width: 320, height: 1_000)
        scrolling.attach(view); scrolling.setActive(true)
        for phase in 0..<3 {
            view.contentOffset.y = 200
            scrolling.bottom(animated: false)
            view.simulatedTracking = phase == 0; view.simulatedDragging = phase == 1; view.simulatedDeceleration = phase == 2
            await settle()
            XCTAssertEqual(view.contentOffset.y, 200, "Pending following must respect tracking, dragging, and deceleration")
            view.simulatedTracking = false; view.simulatedDragging = false; view.simulatedDeceleration = false
        }
        scrolling.bottom(animated: false)
        await settle()
        XCTAssertEqual(view.contentOffset.y, 520)
    }
    func testExplicitJumpInterruptsMomentumAndCancelsQueuedFollowing() async {
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = GestureScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        window.addSubview(view); view.contentSize = CGSize(width: 320, height: 1_000)
        scrolling.attach(view); scrolling.setActive(true)
        view.contentOffset.y = 200
        scrolling.bottom(animated: false)
        view.simulatedDeceleration = true
        scrolling.jump(animated: false)
        XCTAssertEqual(view.contentOffset.y, 520, "An explicit jump must not wait for momentum to finish")
        await settle()
        XCTAssertEqual(view.contentOffset.y, 520)
    }
}
