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
    private var followsBottom = false
    private var active = false
    private var positionRevision = 0
    private var adjusting = false
    private var restoration: (anchor: ReadingAnchor, revision: Int)?
    private var rowOrder: [String] = []
    private var rowPositions: [String: Int] = [:]
    private var requestedRow: (path: IndexPath, height: CGFloat)?

    func updateRows(_ ids: [String]) {
        guard ids != rowOrder else { return }
        rowOrder = ids
        requestedRow = nil
        rowPositions = Dictionary(ids.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { first, _ in first })
    }

    func setActive(_ value: Bool) {
        active = value
        if !value { cancel() }
    }
    func attach(_ view: UIScrollView) {
        guard view.window != nil else { return }
        self.view = view
        layoutUpdated()
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
        followsBottom = true; restoration = nil
        scheduled?.cancel()
        scheduled = Task { @MainActor [weak self] in
            await Task.yield()
            guard !Task.isCancelled, let self, self.active, let view = self.view, view.window != nil else { return }
            // A request queued before touch-down must not fight that gesture.
            guard !view.isTracking, !view.isDragging, !view.isDecelerating else { return }
            self.moveToBottom(view, animated: animated)
        }
        return scheduled
    }
    /// Row measurement can change List's estimated height during a layout
    /// pass. Align before that pass is displayed, rather than one task later.
    func layoutUpdated() {
        guard !adjusting, active, let view, view.window != nil,
              !view.isTracking, !view.isDragging, !view.isDecelerating else { return }
        adjusting = true; defer { adjusting = false }
        if let restoration, restoration.revision == positionRevision {
            alignReading(restoration.anchor, in: view)
        } else if followsBottom {
            let y = bottomOffset(view)
            if abs(view.contentOffset.y - y) > 0.5 {
                UIView.performWithoutAnimation { view.setContentOffset(CGPoint(x: view.contentOffset.x, y: y), animated: false) }
            }
        }
    }
    /// Explicit navigation owns the scroll immediately, including during momentum.
    /// It cannot be replaced by a queued automatic follow request.
    func jump(animated: Bool) {
        cancel()
        guard active, let view, view.window != nil else { return }
        // Lazy row measurements can revise the bottom after this first move.
        followsBottom = true
        view.setContentOffset(view.contentOffset, animated: false)
        moveToBottom(view, animated: animated)
    }
    private func moveToBottom(_ view: UIScrollView, animated: Bool) {
        view.layoutIfNeeded()
        let y = bottomOffset(view)
        guard abs(view.contentOffset.y - y) > 0.5 else { return }
        view.setContentOffset(CGPoint(x: view.contentOffset.x, y: y), animated: animated)
    }
    private func bottomOffset(_ view: UIScrollView) -> CGFloat {
        max(-view.adjustedContentInset.top, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
    }
    func cancel() {
        scheduled?.cancel(); scheduled = nil; followsBottom = false; restoration = nil; requestedRow = nil
        positionRevision += 1
    }
    func readingAnchor() -> ReadingAnchor? {
        // Capturing reading intent also cancels pending follow/restore work.
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
        restoration = (anchor, revision)
        scheduled = Task { @MainActor [weak self] in
            await Task.yield()
            guard !Task.isCancelled, let self, self.active, self.positionRevision == revision,
                  let view = self.view, view.window != nil, ObjectIdentifier(view) == anchor.view,
                  !view.isTracking, !view.isDragging, !view.isDecelerating else { return }
            view.layoutIfNeeded()
            self.alignReading(anchor, in: view)
        }
        return scheduled
    }
    private func alignReading(_ anchor: ReadingAnchor, in view: UIScrollView) {
        guard ObjectIdentifier(view) == anchor.view else { return }
        var realizedIDs: Set<String>?
        if let list = view as? UICollectionView {
            guard !list.hasUncommittedUpdates else { return }
            let counts = (0..<list.numberOfSections).map { list.numberOfItems(inSection: $0) }
            guard counts.reduce(0, +) == rowOrder.count else { return }
            // Validate the row order against realized cells, so an old SwiftUI
            // snapshot can never supply an index to a newer native collection.
            var matched: Set<String> = []
            for (id, reference) in rows {
                guard let row = reference.view, row.window != nil, let expected = rowPositions[id] else { continue }
                var ancestor: UIView? = row
                while let current = ancestor, !(current is UICollectionViewCell) { ancestor = current.superview }
                guard let cell = ancestor as? UICollectionViewCell, let path = list.indexPath(for: cell) else { continue }
                guard counts.prefix(path.section).reduce(0, +) + path.item == expected else { return }
                matched.insert(id)
            }
            guard !matched.isEmpty else { return }
            realizedIDs = matched
            if !anchor.rows.contains(where: { matched.contains($0.id) }),
               let target = anchor.rows.first(where: { rowPositions[$0.id] != nil }), var index = rowPositions[target.id] {
                for (section, count) in counts.enumerated() {
                    if index < count {
                        let path = IndexPath(item: index, section: section), height = list.contentSize.height
                        if requestedRow?.path != path || requestedRow?.height != height {
                            requestedRow = (path, height)
                            list.scrollToItem(at: path, at: .top, animated: false)
                        }
                        break
                    }
                    index -= count
                }
                return // Its probe will align the measured row before display.
            }
        }
        // Keep the surviving row steady through subsequent estimated-height
        // corrections too. A new reading gesture or explicit jump cancels it.
        let target = anchor.rows.first { rows[$0.id]?.view?.window != nil && realizedIDs?.contains($0.id) != false }
        guard let target, let row = rows[target.id]?.view else { return }
        let top = -view.adjustedContentInset.top
        let y = min(bottomOffset(view), max(top, row.convert(row.bounds, to: view).minY - target.relativeY))
        guard abs(view.contentOffset.y - y) > 0.5 else { return }
        UIView.performWithoutAnimation { view.setContentOffset(CGPoint(x: view.contentOffset.x, y: y), animated: false) }
    }
}

/// A row background always has the list as an ancestor, including the first
/// empty/loading row. No global window search or private UIKit API is needed.
struct NativeListScrollProbe: UIViewRepresentable {
    let scrolling: NativeListScrolling
    var rowID: String? = nil
    var rowOrder: [String] = []
    func makeUIView(context: Context) -> Probe {
        scrolling.updateRows(rowOrder)
        return Probe(scrolling: scrolling, rowID: rowID)
    }
    func updateUIView(_ uiView: Probe, context: Context) {
        scrolling.updateRows(rowOrder)
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
        override func layoutSubviews() {
            super.layoutSubviews()
            scrolling?.layoutUpdated()
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
