import XCTest
import UIKit
@testable import FalconDeckNative

@MainActor final class NativeListScrollingTests: XCTestCase {
    private func viewport(in window: UIWindow) -> UIScrollView {
        let view = UIScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        view.contentSize = CGSize(width: 320, height: 1_000)
        window.addSubview(view)
        return view
    }
    private func settle() async { for _ in 0..<5 { await Task.yield() } }
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
}
