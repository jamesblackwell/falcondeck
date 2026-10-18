import SwiftUI

/// Keeps the familiar 48pt control footprint; only its paint responds to touch.
struct ComposerControlStyle: ButtonStyle {
    enum Role: Equatable { case secondary, model, send, stop }
    var role: Role = .secondary
    var inset: CGFloat = 4
    func makeBody(configuration: Configuration) -> some View {
        ComposerControlBody(label: configuration.label, pressed: configuration.isPressed, role: role, secondaryInset: inset)
    }
}

private struct ComposerControlBody<Label: View>: View {
    @Environment(\.nativeMotion) private var motion
    @Environment(\.isEnabled) private var enabled
    let label: Label
    let pressed: Bool
    let role: ComposerControlStyle.Role
    let secondaryInset: CGFloat
    @State private var response = 0
    private var prominent: Bool { role == .send || role == .stop }
    private var radius: CGFloat { role == .model ? 14 : 24 }
    private var inset: CGFloat { prominent ? 0 : secondaryInset }
    private var fill: Color {
        switch role {
        case .send: FD.accent.opacity(enabled ? 1 : 0.15)
        case .stop: FD.foreground
        case .secondary: FD.raised.opacity(pressed ? 1 : 0.65)
        case .model: FD.raised.opacity(pressed ? 0.85 : 0)
        }
    }
    private var ink: Color {
        if prominent { return enabled ? FD.background : FD.secondary }
        return pressed ? FD.accent : FD.secondary
    }
    var body: some View {
        label
            .foregroundStyle(ink)
            .opacity(enabled || prominent ? 1 : 0.4)
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(fill)
                    .overlay {
                        RoundedRectangle(cornerRadius: radius, style: .continuous)
                            .strokeBorder(LinearGradient(colors: [FD.foreground.opacity(prominent ? 0.22 : 0.12), FD.line.opacity(0.3)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.75)
                            .opacity(role == .model && !pressed ? 0 : 1)
                    }
                    .overlay {
                        if motion.effectsEnabled && enabled {
                            ComposerTouchResponse(trigger: response, radius: radius, color: prominent ? FD.foreground : FD.accent)
                        }
                    }
                    .padding(inset)
                    .shadow(color: role == .send && enabled ? FD.accent.opacity(pressed ? 0.08 : 0.18) : .clear, radius: pressed ? 2 : 5, y: pressed ? 0 : 2)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
            .scaleEffect(pressed && motion.active && !motion.reduceMotion ? (role == .model ? 0.98 : 0.91) : 1)
            .animation(motion.interactionAnimation, value: pressed)
            .animation(motion.interactionAnimation, value: enabled)
            .hoverEffect(.highlight)
            .sensoryFeedback(trigger: pressed) { _, down in
                guard down, enabled, motion.active else { return nil }
                return prominent ? .impact(weight: .light, intensity: 0.65) : .selection
            }
            .onChange(of: pressed) { _, down in
                if down && enabled && motion.effectsEnabled { response &+= 1 }
            }
            .onChange(of: enabled) { old, ready in
                if !old && ready && role == .send && motion.effectsEnabled { response &+= 1 }
            }
            .onChange(of: role) { _, next in
                if next == .send && enabled && motion.effectsEnabled { response &+= 1 }
            }
    }
}

/// SwiftUI's finite keyframes drive this small Metal surface. No idle clock,
/// whole-composer shader, or animation of glass/transcript opacity is involved.
private struct ComposerTouchResponse: View {
    let trigger: Int
    let radius: CGFloat
    let color: Color
    var body: some View {
        GeometryReader { geometry in
            RoundedRectangle(cornerRadius: radius, style: .continuous).fill(color)
                .keyframeAnimator(initialValue: CGFloat(1), trigger: trigger) { surface, phase in
                    surface.colorEffect(ShaderLibrary.composerResponse(
                        .float2(Float(geometry.size.width), Float(geometry.size.height)),
                        .float(Float(phase)), .color(color)))
                } keyframes: { _ in
                    MoveKeyframe(CGFloat(0))
                    LinearKeyframe(CGFloat(1), duration: 0.55)
                }
        }.clipShape(.rect(cornerRadius: radius))
            .allowsHitTesting(false).accessibilityHidden(true)
    }
}
