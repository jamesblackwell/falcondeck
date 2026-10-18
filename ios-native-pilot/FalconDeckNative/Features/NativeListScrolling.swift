import SwiftUI

/// Scroll a native list by its laid-out bounds. ScrollViewProxy retains an
/// item index until SwiftUI's next collection update; that index can be invalid
/// when a streamed tool group changes rows or its conversation disappears.
@MainActor final class NativeListScrolling {
    struct ReadingAnchor {
        fileprivate let view: ObjectIdentifier
        fileprivate let revision: Int
        fileprivate let rows: [(id: String, relativeY: CGFloat)]
    }
    private struct WeakRow { weak var view: UIView? }
    private weak var view: UIScrollView?
    private var rows: [String: WeakRow] = [:]
    private var scheduled: Task<Void, Never>?
    private var wantsBottom = false
    private var active = false
    private var positionRevision = 0

    func setActive(_ value: Bool) {
        active = value
        if !value { cancel() }
    }
    func attach(_ view: UIScrollView) {
        guard view.window != nil else { return }
        self.view = view
        if wantsBottom && active { bottom(animated: false) }
    }
    func register(_ row: UIView, id: String) {
        rows[id] = WeakRow(view: row)
        if rows.count > 256 { rows = rows.filter { $0.value.view?.window != nil } }
    }
    func unregister(_ row: UIView, id: String) {
        if rows[id]?.view === row { rows.removeValue(forKey: id) }
    }
    @discardableResult func bottom(animated: Bool) -> Task<Void, Never>? {
        guard active else { return nil }
        wantsBottom = true
        scheduled?.cancel()
        scheduled = Task { @MainActor [weak self] in
            await Task.yield()
            guard !Task.isCancelled, let self, self.active, let view = self.view, view.window != nil else { return }
            self.wantsBottom = false
            // A request queued before touch-down must not fight that gesture.
            guard !view.isTracking, !view.isDragging, !view.isDecelerating else { return }
            self.moveToBottom(view, animated: animated)
        }
        return scheduled
    }
    /// Explicit navigation owns the scroll immediately, including during momentum.
    /// It cannot be replaced by a queued automatic follow request.
    func jump(animated: Bool) {
        cancel()
        guard active, let view, view.window != nil else { return }
        view.setContentOffset(view.contentOffset, animated: false)
        moveToBottom(view, animated: animated)
    }
    private func moveToBottom(_ view: UIScrollView, animated: Bool) {
        view.layoutIfNeeded()
        let y = max(-view.adjustedContentInset.top, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
        guard abs(view.contentOffset.y - y) > 0.5 else { return }
        view.setContentOffset(CGPoint(x: view.contentOffset.x, y: y), animated: animated)
    }
    func cancel() {
        scheduled?.cancel(); scheduled = nil; wantsBottom = false
        positionRevision += 1
    }
    func readingAnchor() -> ReadingAnchor? {
        cancel()
        guard active, let view else { return nil }
        let visibleTop = view.contentOffset.y + view.adjustedContentInset.top
        let visibleBottom = view.contentOffset.y + view.bounds.height - view.adjustedContentInset.bottom
        let visible = rows.compactMap { id, reference -> (id: String, relativeY: CGFloat)? in
            guard let row = reference.view, row.window != nil else { return nil }
            let frame = row.convert(row.bounds, to: view)
            guard frame.maxY > visibleTop, frame.minY < visibleBottom else { return nil }
            return (id, frame.minY - view.contentOffset.y)
        }.sorted { $0.relativeY < $1.relativeY }
        guard !visible.isEmpty else { return nil }
        return ReadingAnchor(view: ObjectIdentifier(view), revision: positionRevision, rows: visible)
    }
    @discardableResult func restore(_ anchor: ReadingAnchor) -> Task<Void, Never>? {
        guard anchor.revision == positionRevision else { return nil }
        cancel()
        let revision = positionRevision
        scheduled = Task { @MainActor [weak self] in
            await Task.yield()
            guard !Task.isCancelled, let self, self.active, self.positionRevision == revision,
                  let view = self.view, view.window != nil, ObjectIdentifier(view) == anchor.view,
                  !view.isTracking, !view.isDragging, !view.isDecelerating else { return }
            view.layoutIfNeeded()
            // Anchor to an actual surviving row. A live response may grow
            // below it while older history is fetched; total height is not an
            // insertion offset. If all rows were regrouped, let List preserve
            // its native reading position rather than guessing a new offset.
            let target = anchor.rows.first { self.rows[$0.id]?.view?.window != nil }
            guard let target, let row = self.rows[target.id]?.view else { return }
            let top = -view.adjustedContentInset.top
            let bottom = max(top, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
            let y = min(bottom, max(top, row.convert(row.bounds, to: view).minY - target.relativeY))
            view.setContentOffset(CGPoint(x: view.contentOffset.x, y: y), animated: false)
        }
        return scheduled
    }
}

/// A row background always has the list as an ancestor, including the first
/// empty/loading row. No global window search or private UIKit API is needed.
struct NativeListScrollProbe: UIViewRepresentable {
    let scrolling: NativeListScrolling
    var rowID: String? = nil
    func makeUIView(context: Context) -> Probe { Probe(scrolling: scrolling, rowID: rowID) }
    func updateUIView(_ uiView: Probe, context: Context) {
        if uiView.rowID != rowID || uiView.scrolling !== scrolling, let old = uiView.rowID { uiView.scrolling?.unregister(uiView, id: old) }
        uiView.scrolling = scrolling; uiView.rowID = rowID; uiView.attach()
    }

    final class Probe: UIView {
        weak var scrolling: NativeListScrolling?
        var rowID: String?
        init(scrolling: NativeListScrolling, rowID: String?) {
            self.scrolling = scrolling; self.rowID = rowID; super.init(frame: .zero)
            isUserInteractionEnabled = false; backgroundColor = .clear
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window == nil, let rowID { scrolling?.unregister(self, id: rowID) }
            // UIKit may not have finished installing the hosting cell yet.
            DispatchQueue.main.async { [weak self] in self?.attach() }
        }
        func attach() {
            guard window != nil else { return }
            var ancestor = superview
            while let current = ancestor {
                if let list = current as? UICollectionView {
                    scrolling?.attach(list)
                    if let rowID { scrolling?.register(self, id: rowID) }
                    return
                }
                ancestor = current.superview
            }
        }
    }
}
