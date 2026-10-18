import SwiftUI
import Combine

struct NativeMotionPolicy: Equatable {
    var active = true
    var reduceMotion = false
    var lowPower = false
    var effectsEnabled: Bool { active && !reduceMotion && !lowPower }
    var interactionAnimation: Animation? { active && !reduceMotion ? .snappy(duration: 0.22, extraBounce: 0) : nil }
}

private struct NativeMotionKey: EnvironmentKey {
    static let defaultValue = NativeMotionPolicy(active: false)
}

extension EnvironmentValues {
    var nativeMotion: NativeMotionPolicy {
        get { self[NativeMotionKey.self] }
        set { self[NativeMotionKey.self] = newValue }
    }
}

/// One scene-level policy; animation clocks belong to the individual effects.
struct NativeMotionScope: ViewModifier {
    @Environment(\.scenePhase) private var scene
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    private var policy: NativeMotionPolicy {
        var value = NativeMotionPolicy(active: scene == .active, reduceMotion: reduceMotion, lowPower: lowPower)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--motion-reduce") { value.reduceMotion = true }
        if ProcessInfo.processInfo.arguments.contains("--motion-low-power") { value.lowPower = true }
        #endif
        return value
    }
    func body(content: Content) -> some View {
        content.environment(\.nativeMotion, policy)
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange).receive(on: RunLoop.main)) { _ in
                lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
            }
            .onChange(of: scene) { _, phase in
                if phase == .active { lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled }
            }
    }
}

struct NativePressStyle: ButtonStyle {
    @Environment(\.nativeMotion) private var motion
    var scales = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed && scales && motion.effectsEnabled ? 0.96 : 1)
            .animation(motion.interactionAnimation, value: configuration.isPressed)
    }
}

struct NativeDisclosureChevron: View {
    @Environment(\.nativeMotion) private var motion
    let expanded: Bool
    var size: CGFloat = 10
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: size, weight: .semibold))
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .animation(motion.interactionAnimation, value: expanded)
            .accessibilityHidden(true)
    }
}

/// The shader changes only the ink. It cannot move text or resize a list row.
struct NativeActivityText: View {
    @Environment(\.nativeMotion) private var motion
    let text: String
    var active = true
    @State private var visible = false
    @State private var epoch = Date()
    @State private var size = CGSize.zero
    var body: some View {
        ZStack(alignment: .leading) {
            if active && motion.effectsEnabled {
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !visible)) { timeline in
                    Text(text).colorEffect(ShaderLibrary.activitySweep(
                        .float2(Float(size.width), Float(size.height)),
                        .float(Float(timeline.date.timeIntervalSince(epoch))), .color(FD.foreground)))
                }
            } else { Text(text) }
        }
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
        .onAppear { epoch = .now; visible = true }
        .onDisappear { visible = false }
        .onScrollVisibilityChange(threshold: 0.01) { visible = $0 }
    }
}
