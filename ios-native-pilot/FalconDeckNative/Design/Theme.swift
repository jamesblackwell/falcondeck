import SwiftUI

/// Shared design tokens adapted to the native appearance catalog.
@MainActor enum FD {
    static var background: Color { NativeAppearance.shared.color("surface", "0") }
    static var surface: Color { NativeAppearance.shared.color("surface", "1") }
    static var raised: Color { NativeAppearance.shared.color("surface", "2") }
    static var foreground: Color { NativeAppearance.shared.color("fg", "primary") }
    static var body: Color { NativeAppearance.shared.color("fg", "secondary") }
    static var secondary: Color { NativeAppearance.shared.color("fg", "tertiary") }
    static var muted: Color { NativeAppearance.shared.color("fg", "muted") }
    static var accent: Color { NativeAppearance.shared.color("accent") }
    static var accentStrong: Color { NativeAppearance.shared.color("accent", "strong") }
    static var accentDim: Color { NativeAppearance.shared.color("accent", "dim") }
    static var line: Color { NativeAppearance.shared.color("border") }
    static var hairline: Color { NativeAppearance.shared.color("border", "subtle") }
    static var warning: Color { NativeAppearance.shared.color("warning") }
    static var danger: Color { NativeAppearance.shared.color("danger") }
    static var success: Color { NativeAppearance.shared.color("success") }
    static var info: Color { NativeAppearance.shared.color("info") }
    static var unread: Color { NativeAppearance.shared.color("unread") }
    static let radius: CGFloat = 20
    static let inset: CGFloat = 20
}

/// The pulse runs on the render server. A repeating SwiftUI symbol effect asks
/// for a new display list every frame for as long as any task is running.
struct ActivityDiamond: View {
    @Environment(\.nativeMotion) private var motion
    var size: CGFloat = 8
    var color: Color? = nil
    var body: some View {
        PulsingDiamond(color: UIColor(color ?? FD.accent), animated: motion.effectsEnabled)
            .frame(width: size, height: size)
            .padding(2)
            .accessibilityLabel("Loading")
    }
}

private struct PulsingDiamond: UIViewRepresentable {
    let color: UIColor
    let animated: Bool
    func makeUIView(context: Context) -> DiamondView { DiamondView() }
    func updateUIView(_ view: DiamondView, context: Context) { view.apply(color: color, animated: animated) }

    final class DiamondView: UIView {
        private let shape = CAShapeLayer()
        private var tint: UIColor = .tintColor
        private var animated = false
        init() {
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            backgroundColor = .clear
            layer.addSublayer(shape)
        }
        @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
        func apply(color: UIColor, animated: Bool) {
            tint = color
            shape.fillColor = color.resolvedColor(with: traitCollection).cgColor
            if self.animated != animated { self.animated = animated; updateAnimation() }
        }
        override func layoutSubviews() {
            super.layoutSubviews()
            CATransaction.begin(); CATransaction.setDisableActions(true)
            shape.frame = bounds
            let side = min(bounds.width, bounds.height), mid = CGPoint(x: bounds.midX, y: bounds.midY)
            let path = CGMutablePath()
            path.move(to: CGPoint(x: mid.x, y: mid.y - side / 2))
            path.addLine(to: CGPoint(x: mid.x + side / 2, y: mid.y))
            path.addLine(to: CGPoint(x: mid.x, y: mid.y + side / 2))
            path.addLine(to: CGPoint(x: mid.x - side / 2, y: mid.y))
            path.closeSubpath()
            shape.path = path
            CATransaction.commit()
        }
        override func traitCollectionDidChange(_ previous: UITraitCollection?) {
            super.traitCollectionDidChange(previous)
            shape.fillColor = tint.resolvedColor(with: traitCollection).cgColor
        }
        // Core Animation drops animations from detached layers; restore on attach.
        override func didMoveToWindow() { super.didMoveToWindow(); updateAnimation() }
        private func updateAnimation() {
            shape.removeAnimation(forKey: "pulse")
            guard animated, window != nil else { shape.opacity = 1; return }
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1; pulse.toValue = 0.3
            pulse.duration = 0.9; pulse.autoreverses = true; pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            shape.add(pulse, forKey: "pulse")
        }
    }
}

/// Projects without a daemon icon get a stable monogram tile.
struct ProjectIcon: View {
    let name: String
    var size: CGFloat = 28
    var body: some View {
        let letter = name.trimmingCharacters(in: .whitespacesAndNewlines).first.map { String($0).uppercased() } ?? "•"
        let tone = NativeAppearance.shared.color("cat", String(Self.tone(for: name)))
        Text(letter)
            .font(.system(size: size * 0.58, weight: .semibold, design: .rounded))
            .foregroundStyle(tone)
            .frame(width: size, height: size)
            .background(tone.opacity(0.16), in: .rect(cornerRadius: size * 0.28, style: .continuous))
    }
    /// FNV-1a keeps a project's tone stable across launches, unlike `hashValue`.
    static func tone(for name: String) -> Int {
        var hash: UInt32 = 2166136261
        for byte in name.lowercased().utf8 { hash = (hash ^ UInt32(byte)) &* 16777619 }
        return Int(hash % 12) + 1
    }
}

/// Option sheets use the available height when larger text needs more room.
private struct NativeOptionsSheet: ViewModifier {
    @Environment(\.dynamicTypeSize) private var textSize
    func body(content: Content) -> some View {
        content.presentationDetents(textSize.isAccessibilitySize ? [.large] : [.medium, .large])
            .presentationDragIndicator(.visible)
    }
}

extension View {
    func nativeOptionsSheet() -> some View { modifier(NativeOptionsSheet()) }
}
