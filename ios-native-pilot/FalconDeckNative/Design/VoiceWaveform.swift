import SwiftUI

/// Bounded audio snapshots, interpolated without increasing microphone sampling.
struct WaveformTransition {
    private(set) var previous: [Float] = []
    private(set) var current: [Float] = []
    private(set) var updatedAt = Date.distantPast
    static let interval: TimeInterval = 0.1
    var frameDates: [Date] { (1...3).map { updatedAt.addingTimeInterval(Double($0) * Self.interval / 3) } }

    mutating func update(_ levels: [Float], at date: Date) {
        previous = samples(count: current.count, at: date)
        let next = levels.suffix(120).map { $0.isFinite ? min(1, max(0, $0)) : 0 }
        if current.isEmpty { previous = next }
        current = next; updatedAt = date
    }
    func samples(count: Int, at date: Date, animated: Bool = true) -> [Float] {
        let count = max(0, min(120, count))
        let old = previous.suffix(count), next = current.suffix(count)
        let progress = animated ? Float(min(1, max(0, date.timeIntervalSince(updatedAt) / Self.interval))) : 1
        return next.enumerated().map { index, value in
            let from = index < old.count ? old[old.startIndex + index] : 0
            return from + (value - from) * progress
        }
    }
}

struct VoiceWaveform: View {
    @Environment(\.nativeMotion) private var motion
    let recorder: VoiceRecorder
    @State private var transition = WaveformTransition()
    @State private var visible = false
    var body: some View {
        ZStack(alignment: .leading) {
            if motion.effectsEnabled && visible {
                // Only three frames per audio snapshot; silence cannot leave
                // an idle display-rate clock running after the levels settle.
                TimelineView(.explicit(transition.frameDates)) { timeline in
                    drawing(at: timeline.date)
                }
            } else { drawing(at: .now) }
        }
        .onChange(of: recorder.levels, initial: true) { _, levels in transition.update(levels, at: .now) }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .accessibilityHidden(true)
    }
    private func drawing(at date: Date) -> some View {
        let ink = FD.secondary, empty = FD.line
        let transition = transition, animated = motion.effectsEnabled
        return Canvas { context, size in
            guard size.width >= 3, size.height >= 4 else { return }
            let count = max(1, min(120, Int((size.width + 3) / 6)))
            let samples = transition.samples(count: count, at: date, animated: animated)
            var waveform = Path(), baseline = Path()
            for index in 0..<count {
                let height: CGFloat = index < samples.count ? 4 + CGFloat(samples[index]) * 22 : 4
                let rect = CGRect(x: CGFloat(index) * 6, y: (size.height - height) / 2, width: 3, height: height)
                if index < samples.count { waveform.addRoundedRect(in: rect, cornerSize: CGSize(width: 1.5, height: 1.5)) }
                else { baseline.addRoundedRect(in: rect, cornerSize: CGSize(width: 1.5, height: 1.5)) }
            }
            context.fill(baseline, with: .color(empty))
            context.fill(waveform, with: .color(ink))
        }
    }
}
