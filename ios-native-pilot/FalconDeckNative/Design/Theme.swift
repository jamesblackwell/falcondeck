import SwiftUI

/// Shared design tokens adapted to the native appearance catalog.
@MainActor enum FD {
    static var background: Color { NativeAppearance.shared.color("surface", "0") }
    static var surface: Color { NativeAppearance.shared.color("surface", "1") }
    static var raised: Color { NativeAppearance.shared.color("surface", "2") }
    static var foreground: Color { NativeAppearance.shared.color("fg", "primary") }
    static var secondary: Color { NativeAppearance.shared.color("fg", "tertiary") }
    static var muted: Color { NativeAppearance.shared.color("fg", "muted") }
    static var accent: Color { NativeAppearance.shared.color("accent") }
    static var line: Color { NativeAppearance.shared.color("border") }
    static let radius: CGFloat = 20
    static let inset: CGFloat = 20

    static func symbol(for name: String) -> String {
        if name.localizedCaseInsensitiveContains("falcon") { return "bird.fill" }
        if name.localizedCaseInsensitiveContains("quiz") { return "graduationcap.fill" }
        if name.localizedCaseInsensitiveContains("look") { return "camera.aperture" }
        if name.localizedCaseInsensitiveContains("pic") { return "photo.stack.fill" }
        return "folder.fill"
    }
}

struct ActivityDiamond: View {
    @Environment(\.nativeMotion) private var motion
    @State private var visible = false
    var body: some View {
        Image(systemName: "diamond.fill")
            .font(.caption2).foregroundStyle(FD.accent)
            // Animate the symbol, so transcript reflow cannot animate its placement.
            .symbolEffect(.pulse, options: .repeating, isActive: motion.effectsEnabled && visible)
            .accessibilityLabel("Loading")
            .onAppear { visible = true }.onDisappear { visible = false }
            .onScrollVisibilityChange(threshold: 0.01) { visible = $0 }
    }
}

struct ProjectIcon: View {
    let name: String
    var size: CGFloat = 28
    var body: some View {
        if name.localizedCaseInsensitiveContains("falcon") {
            Image("FalconMark").resizable().scaledToFit().frame(width: size, height: size)
        } else { Image(systemName: FD.symbol(for: name)) }
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
