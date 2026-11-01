#if DEBUG
import Foundation
import QuartzCore
import UIKit

/// Local streaming QA only. Samples the main run loop's frame cadence, the
/// characters actually painted per frame and the transcript's content height,
/// then writes `stream-metrics.json` into Documents. Enabled by `--stream-metrics`.
@MainActor final class StreamMetrics: NSObject {
    static let shared = StreamMetrics()
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("--stream-metrics") }
    /// Paints every delta on arrival, the way the app did before paced reveal: the A/B baseline.
    static let unpaced = ProcessInfo.processInfo.arguments.contains("--stream-unpaced")

    private var link: CADisplayLink?
    private var lastTimestamp: CFTimeInterval = 0
    private var frames: [Double] = []
    private var steps: [Int] = []
    private var heights: [Double] = []
    private var shown = 0
    private var lastShown = 0
    private var height: Double = 0
    private var lastHeight: Double = 0
    private var started: CFTimeInterval = 0
    private var observer: CFRunLoopObserver?
    private var turnStart: CFTimeInterval = 0
    private var turns: [Double] = []

    func begin() {
        guard Self.enabled else { return }
        frames = []; steps = []; heights = []; shown = 0; lastShown = 0; height = 0; lastHeight = 0
        started = CACurrentMediaTime(); lastTimestamp = 0
        link?.invalidate()
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common); self.link = link
        // Main-thread busy time per run-loop turn: what each paint really costs.
        turns = []
        let activities: CFRunLoopActivity = [.afterWaiting, .beforeWaiting]
        observer = CFRunLoopObserverCreateWithHandler(nil, activities.rawValue, true, 0) { [weak self] _, activity in
            MainActor.assumeIsolated {
                guard let self else { return }
                if activity == .afterWaiting { self.turnStart = CACurrentMediaTime() }
                else if self.turnStart > 0 { self.turns.append((CACurrentMediaTime() - self.turnStart) * 1000); self.turnStart = 0 }
            }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
    }

    /// Characters currently painted for the live reply.
    func painted(_ count: Int) { if link != nil { shown = count } }
    func contentHeight(_ value: Double) { if link != nil { height = value } }

    @objc private func tick(_ link: CADisplayLink) {
        if lastTimestamp > 0 { frames.append((link.timestamp - lastTimestamp) * 1000) }
        lastTimestamp = link.timestamp
        steps.append(shown - lastShown); lastShown = shown
        if lastHeight > 0 { heights.append(height - lastHeight) }
        lastHeight = height
    }

    func end() {
        guard let link else { return }
        link.invalidate(); self.link = nil
        if let observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes); self.observer = nil }
        let busy = turns.sorted()
        func turnPct(_ p: Double) -> Double { busy.isEmpty ? 0 : busy[min(busy.count - 1, Int(Double(busy.count) * p))] }
        let duration = CACurrentMediaTime() - started
        let sorted = frames.sorted()
        func pct(_ p: Double) -> Double { sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))] }
        let active = steps.filter { $0 > 0 }
        let moves = heights.filter { abs($0) > 0.5 }
        let report: [String: Any] = [
            "duration_s": duration, "frames": frames.count,
            "frame_ms_p50": pct(0.5), "frame_ms_p95": pct(0.95), "frame_ms_max": sorted.last ?? 0,
            "hitches_over_25ms": frames.filter { $0 > 25 }.count,
            "hitches_over_50ms": frames.filter { $0 > 50 }.count,
            "paint_frames": active.count,
            "paint_hz": Double(active.count) / max(duration, 0.001),
            "paint_step_mean_chars": active.isEmpty ? 0 : Double(active.reduce(0, +)) / Double(active.count),
            "paint_step_max_chars": active.max() ?? 0,
            "paint_step_p95_chars": active.sorted()[safe: Int(Double(active.count) * 0.95)] ?? 0,
            "height_moves": moves.count,
            "height_move_max_pt": moves.map { abs($0) }.max() ?? 0,
            "height_move_sum_pt": moves.reduce(0) { $0 + abs($1) },
            "main_busy_ms_per_s": busy.reduce(0, +) / max(duration, 0.001),
            "main_turn_ms_p50": turnPct(0.5), "main_turn_ms_p95": turnPct(0.95), "main_turn_ms_max": busy.last ?? 0,
            "painted_chars": shown
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]),
              let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        try? data.write(to: docs.appendingPathComponent("stream-metrics.json"))
        NSLog("STREAM-METRICS %@", String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\n", with: " "))
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
#endif
