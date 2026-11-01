import Foundation
import Observation
import QuartzCore
import UIKit

/// Paces what is painted, never what is received. The transcript keeps every wire
/// delta for copy, speech and export; this only decides how much of the live
/// tail is revealed on each frame.
///
/// The daemon merges deltas into ~100 ms batches, so text arrives in bursts of
/// a few dozen characters. Painting each burst the moment it lands reads as
/// steps. Instead the buffered tail drains on the display link, at a rate that
/// follows the backlog: a larger backlog drains faster, so the painted text
/// never trails the wire by more than `latency`, and a single burst spreads
/// over the following frames.
@MainActor @Observable final class StreamingText {
    private(set) var value: String?
    @ObservationIgnored private var target = ""
    @ObservationIgnored private var shown = "".startIndex
    @ObservationIgnored private var credit = 0.0
    @ObservationIgnored private var lastFrame: CFTimeInterval = 0
    @ObservationIgnored private var clock: FrameClock?

    /// Whether motion preferences still allow a paced reveal; tests replace it.
    @ObservationIgnored var allowsPacing: () -> Bool = {
        !UIAccessibility.isReduceMotionEnabled && !ProcessInfo.processInfo.isLowPowerModeEnabled
    }

    /// Seconds for the backlog to drain; also the most the display trails the wire.
    static let latency = 0.18
    /// Even a tiny backlog drains at a readable pace instead of one stray letter per frame.
    static let minimumRate = 45.0

    func update(_ text: String, streaming: Bool, paced: Bool = true) {
        var paced = paced
        #if DEBUG
        paced = paced && !StreamMetrics.unpaced
        #endif
        // Reduce Motion and Low Power paint every delta on arrival, whatever the caller asks.
        paced = paced && allowsPacing()
        guard streaming, paced, let value, text.utf16.starts(with: value.utf16) else {
            // Completion, replacement, Reduce Motion and the first sight of a
            // message all show the real text now. Final text is never delayed.
            publish(text); return
        }
        if text.utf8.count == value.utf8.count {
            // Retracted to exactly what is painted: nothing is left to reveal.
            stop(); target = text; shown = text.endIndex; return
        }
        // The old index is valid in the longer string: it is a prefix of it.
        let boundary = text.utf8.index(text.utf8.startIndex, offsetBy: value.utf8.count)
        // A combining mark, joiner or flag half can extend the last painted
        // character. Segment the whole target, not the suffix: if its first
        // `value.count` characters are longer than what is painted, the painted
        // end is not a character boundary there.
        if text.prefix(value.count).utf8.count != value.utf8.count {
            publish(text); return
        }
        target = text; shown = boundary
        guard clock == nil else { return }
        lastFrame = 0
        clock = FrameClock { [weak self] timestamp in
            guard let self else { return false }
            self.advance(to: timestamp); return true
        }
    }

    func displayed(_ text: String, streaming: Bool) -> String {
        guard streaming, let value, text.utf16.starts(with: value.utf16) else { return text }
        return value
    }

    func reset() {
        stop(); value = nil; target = ""
    }

    private func advance(to timestamp: CFTimeInterval) {
        defer { lastFrame = timestamp }
        guard lastFrame > 0 else { return }
        // Preferences can change mid-drain (Control Center, Low Power): stop pacing now.
        guard allowsPacing() else { publish(target); return }
        let elapsed = min(timestamp - lastFrame, 0.1)
        // Backlog and the spend below are both in characters.
        let backlog = target.distance(from: shown, to: target.endIndex)
        guard backlog > 0 else { stop(); return }
        credit += max(Self.minimumRate, Double(backlog) / Self.latency) * elapsed
        let count = Int(credit)
        guard count > 0 else { return }
        credit -= Double(count)
        shown = target.index(shown, offsetBy: count, limitedBy: target.endIndex) ?? target.endIndex
        value = String(target[..<shown])
        #if DEBUG
        StreamMetrics.shared.painted(value?.utf16.count ?? 0)
        #endif
        if shown == target.endIndex { stop() }
    }

    private func publish(_ text: String) {
        stop(); value = text; target = text; shown = text.endIndex
        #if DEBUG
        StreamMetrics.shared.painted(text.utf16.count)
        #endif
    }

    private func stop() {
        clock?.invalidate(); clock = nil; credit = 0
    }
}

/// One display link per live message, running only while a backlog drains.
@MainActor private final class FrameClock: NSObject {
    private var link: CADisplayLink?
    private let onFrame: (CFTimeInterval) -> Bool

    init(onFrame: @escaping (CFTimeInterval) -> Bool) {
        self.onFrame = onFrame
        super.init()
        let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
        // 60 Hz is smooth for text; ProMotion's extra frames would only re-parse more.
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    /// The link retains its target, so a vanished owner must release it here.
    @objc private func frame(_ link: CADisplayLink) { if !onFrame(link.timestamp) { invalidate() } }

    func invalidate() { link?.invalidate(); link = nil }
}
