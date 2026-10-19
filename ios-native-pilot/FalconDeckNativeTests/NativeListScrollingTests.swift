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
    private func finishLayoutCallbacks() async {
        await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
    }
    func testMeasuredRowsStayAtTheBottomBeforeTheNextDisplayPass() async {
        let window = UIWindow(), scrolling = NativeListScrolling(), view = viewport(in: window)
        scrolling.attach(view); scrolling.setActive(true)
        await scrolling.bottom(animated: false)?.value
        view.contentSize.height = 4_000
        scrolling.layoutUpdated()
        XCTAssertEqual(view.contentOffset.y, 3_520, "History replacement must align synchronously, before displaying an old offset")
        view.bounds.size.height = 600
        scrolling.layoutUpdated(); XCTAssertEqual(view.contentOffset.y, 3_400)
        scrolling.cancel(); view.contentOffset.y = 500; view.contentSize.height = 5_000
        scrolling.layoutUpdated(); XCTAssertEqual(view.contentOffset.y, 500, "A reader's position must win over layout following")
    }
    func testLoadedListDoesNotWaitForAnUnrealizedEndRow() async {
        let window = UIWindow(), scrolling = NativeListScrolling(), view = viewport(in: window)
        let message = UIView(frame: CGRect(x: 0, y: 600, width: 320, height: 400)); view.addSubview(message)
        scrolling.attach(view); scrolling.setActive(true); scrolling.register(message, id: "loaded-message")
        await scrolling.bottom(animated: false)?.value; await finishLayoutCallbacks()
        XCTAssertEqual(view.contentOffset.y, 520)
        XCTAssertTrue(message.convert(message.bounds, to: view).intersects(view.bounds))
        view.contentSize.height += 200; message.frame.origin.y += 200
        scrolling.layoutUpdated()
        XCTAssertEqual(view.contentOffset.y, 720, "Following must work from ordinary rows, without an end-row readiness signal")
    }
    func testReopenedListFollowsWithoutWaitingForAnEndMarker() async {
        let window = UIWindow(), scrolling = NativeListScrolling(), view = viewport(in: window)
        scrolling.attach(view); scrolling.setActive(true)
        await scrolling.bottom(animated: false)?.value
        scrolling.setActive(false); view.contentSize.height = 4_000
        scrolling.layoutUpdated(); XCTAssertEqual(view.contentOffset.y, 520)
        scrolling.setActive(true); await scrolling.bottom(animated: false)?.value
        XCTAssertEqual(view.contentOffset.y, 3_520)
        view.contentSize.height = 5_000; scrolling.layoutUpdated()
        XCTAssertEqual(view.contentOffset.y, 4_520)
    }
    func testPendingScrollUsesCurrentLayoutAfterRowsAreReplaced() async {
        var pending: Task<Void, Never>?
        let window = UIWindow()
        let view = viewport(in: window)
        let scrolling = NativeListScrolling(); scrolling.attach(view); scrolling.setActive(true)
        pending = scrolling.bottom(animated: false)
        view.contentSize.height = 100
        await pending?.value
        XCTAssertEqual(view.contentOffset.y, 0)
        view.contentSize.height = 1_800
        pending = scrolling.bottom(animated: false)
        await pending?.value
        XCTAssertEqual(view.contentOffset.y, 1_320)
    }
    func testDisappearingConversationCancelsItsQueuedScroll() async {
        var pending: Task<Void, Never>?
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = viewport(in: window)
        scrolling.attach(view); scrolling.setActive(true)
        pending = scrolling.bottom(animated: false)
        scrolling.setActive(false)
        await pending?.value
        XCTAssertEqual(view.contentOffset.y, 0)
    }
    func testPrependAnchorKeepsPositionAndCannotScrollAReplacementList() async {
        var pending: Task<Void, Never>?
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = viewport(in: window)
        scrolling.attach(view); scrolling.setActive(true)
        view.contentOffset.y = 200
        let row = UIView(frame: CGRect(x: 0, y: 200, width: 320, height: 100))
        view.addSubview(row); scrolling.register(row, id: "reading")
        let anchor = scrolling.readingAnchor()!
        view.contentSize.height += 500 // 300 above the reader; 200 live points below.
        row.frame.origin.y += 300
        pending = scrolling.restore(anchor)
        await pending?.value
        XCTAssertEqual(view.contentOffset.y, 500)
        let replacement = viewport(in: window)
        scrolling.attach(replacement)
        pending = scrolling.restore(anchor)
        await pending?.value
        XCTAssertEqual(replacement.contentOffset.y, 0)
    }
    func testOpeningARowCancelsTheQueuedBottomRequest() async {
        var pending: Task<Void, Never>?
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = viewport(in: window)
        scrolling.attach(view); scrolling.setActive(true)
        pending = scrolling.bottom(animated: false)
        scrolling.cancel()
        await pending?.value
        XCTAssertEqual(view.contentOffset.y, 0)
    }
    func testHistoryAnchorDoesNotUndoANewerReadingGesture() async throws {
        var pending: Task<Void, Never>?
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = viewport(in: window)
        scrolling.attach(view); scrolling.setActive(true); view.contentOffset.y = 200
        let row = UIView(frame: CGRect(x: 0, y: 200, width: 320, height: 100))
        view.addSubview(row); scrolling.register(row, id: "reading")
        let anchor = try XCTUnwrap(scrolling.readingAnchor())
        scrolling.cancel() // The reader drags elsewhere while history is loading.
        view.contentOffset.y = 400; row.frame.origin.y += 300; view.contentSize.height += 300
        pending = scrolling.restore(anchor)
        await pending?.value
        XCTAssertEqual(view.contentOffset.y, 400)
    }
    func testAReadingGestureWinsOverAnAlreadyQueuedBottomRequest() async {
        var pending: Task<Void, Never>?
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = GestureScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        window.addSubview(view); view.contentSize = CGSize(width: 320, height: 1_000)
        scrolling.attach(view); scrolling.setActive(true)
        for phase in 0..<3 {
            view.contentOffset.y = 200
            pending = scrolling.bottom(animated: false)
            view.simulatedTracking = phase == 0; view.simulatedDragging = phase == 1; view.simulatedDeceleration = phase == 2
            await pending?.value
            XCTAssertEqual(view.contentOffset.y, 200, "Pending following must respect tracking, dragging, and deceleration")
            view.simulatedTracking = false; view.simulatedDragging = false; view.simulatedDeceleration = false
        }
        pending = scrolling.bottom(animated: false)
        await pending?.value
        XCTAssertEqual(view.contentOffset.y, 520)
    }
    func testExplicitJumpInterruptsMomentumAndCancelsQueuedFollowing() async {
        var pending: Task<Void, Never>?
        let window = UIWindow(), scrolling = NativeListScrolling()
        let view = GestureScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        window.addSubview(view); view.contentSize = CGSize(width: 320, height: 1_000)
        scrolling.attach(view); scrolling.setActive(true)
        view.contentOffset.y = 200
        pending = scrolling.bottom(animated: false)
        view.simulatedDeceleration = true
        scrolling.jump(animated: false)
        XCTAssertEqual(view.contentOffset.y, 520, "An explicit jump must not wait for momentum to finish")
        await pending?.value
        XCTAssertEqual(view.contentOffset.y, 520)
    }
    func testExplicitJumpFollowsRowsMeasuredAfterTheJump() {
        let window = UIWindow(), scrolling = NativeListScrolling(), view = viewport(in: window)
        scrolling.attach(view); scrolling.setActive(true)
        view.contentOffset.y = 200
        scrolling.jump(animated: false)
        XCTAssertEqual(view.contentOffset.y, 520)
        // Lazy Markdown rows can revise the estimated content height after
        // the jump has already reached the list's previous bottom.
        view.contentSize.height = 1_800
        scrolling.layoutUpdated()
        XCTAssertEqual(view.contentOffset.y, 1_320)
        scrolling.cancel() // A subsequent reading gesture still wins.
        view.contentOffset.y = 400; view.contentSize.height = 2_000
        scrolling.layoutUpdated()
        XCTAssertEqual(view.contentOffset.y, 400)
    }
    func testRecycledReadingRowIsRecoveredOnlyAgainstTheCurrentCollection() async throws {
        let scrolling = NativeListScrolling(), window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        let layout = UICollectionViewFlowLayout(); layout.itemSize = CGSize(width: 320, height: 80)
        layout.minimumLineSpacing = 0; layout.minimumInteritemSpacing = 0
        let view = OffsetCollection(frame: window.bounds, collectionViewLayout: layout)
        view.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "row")
        let source = CollectionRows(ids: (40..<60).map { "row-\($0)" }, scrolling: scrolling)
        defer { withExtendedLifetime(source) {}; window.isHidden = true }
        scrolling.updateRows(source.ids); view.dataSource = source; window.addSubview(view)
        view.reloadData(); view.layoutIfNeeded(); scrolling.attach(view); scrolling.setActive(true)
        view.setContentOffset(CGPoint(x: 0, y: 830), animated: false); view.layoutIfNeeded()
        await finishLayoutCallbacks()
        let anchor = try XCTUnwrap(scrolling.readingAnchor())
        source.ids = (0..<60).map { "row-\($0)" }; view.reloadData(); view.layoutIfNeeded()
        await finishLayoutCallbacks()
        await scrolling.restore(anchor)?.value
        XCTAssertLessThan(view.contentOffset.y, 2_000, "Stale row metadata must not supply an index to a new collection")
        let restored = expectation(description: "Recovered the same row and its 30-point reading offset")
        view.offsetChanged = { y in if abs(y - 4_030) < 1 { restored.fulfill() } }
        scrolling.updateRows(source.ids); scrolling.layoutUpdated(); view.layoutIfNeeded()
        await fulfillment(of: [restored], timeout: 2)
        XCTAssertEqual(view.contentOffset.y, 4_030, accuracy: 1)
    }

    private final class OffsetCollection: UICollectionView {
        var offsetChanged: ((CGFloat) -> Void)?
        override func setContentOffset(_ contentOffset: CGPoint, animated: Bool) {
            super.setContentOffset(contentOffset, animated: animated); offsetChanged?(self.contentOffset.y)
        }
    }
    private final class CollectionRows: NSObject, UICollectionViewDataSource {
        var ids: [String]
        let scrolling: NativeListScrolling
        init(ids: [String], scrolling: NativeListScrolling) { self.ids = ids; self.scrolling = scrolling }
        func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { ids.count }
        func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "row", for: indexPath)
            cell.backgroundView = NativeListScrollProbe.Probe(scrolling: scrolling, rowID: ids[indexPath.item])
            return cell
        }
    }
}
