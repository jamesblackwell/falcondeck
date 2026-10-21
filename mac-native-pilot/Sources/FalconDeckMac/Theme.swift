import AppKit
import Observation
import SwiftUI

/// Shared product palettes, with readable ink on every native content surface.
@MainActor enum FDTheme {
    static var background: Color { themed("surface", "0") }
    static var surface: Color { themed("surface", "1") }
    static var raised: Color { themed("surface", "2") }
    static var hover: Color { themed("surface", "3") }
    static var foreground: Color { themed("fg", "primary") }
    static var secondary: Color { themed("fg", "secondary") }
    static var muted: Color { themed("fg", "tertiary") }
    static var subtle: Color { themed("fg", "muted") }
    static var accent: Color { themed("accent", "default") }
    static var accentStrong: Color { themed("accent", "strong") }
    static var accentMuted: Color { themed("accent", "muted") }
    static var accentDim: Color { themed("accent", "dim") }
    static var line: Color { themed("border", "default") }
    static var hairline: Color { themed("border", "subtle") }
    static var warning: Color { themed("warning", "default") }
    static var danger: Color { themed("danger", "default") }
    static var info: Color { themed("info", "default") }
    static var codeKeyword: Color { themed("code", "keyword") }
    static var codeNumber: Color { themed("code", "number") }
    static var codeString: Color { themed("code", "string") }

    static let palettes: [String: NativeThemePalette] = {
        guard let url = Bundle.module.url(forResource: "PaletteCatalog", withExtension: "json"),
              let data = try? Data(contentsOf: url), let root = try? JSON.decode(data) else { return [:] }
        return Dictionary(uniqueKeysWithValues: root["themes"].array.map { ($0["id"].string, NativeThemePalette(raw: $0)) })
    }()

    static func categoryColor(_ token: String) -> Color { themed("cat", token) }

    private static var resolved: [String: Color] = [:]
    private static var resolvedKey = ""

    /// Every call used to mint a fresh dynamic `NSColor`, so no two reads of the
    /// same token compared equal. SwiftUI then treated every themed view as
    /// changed on each render pass and rebuilt the whole display list. Resolving
    /// each token once per appearance keeps those comparisons cheap.
    private static func themed(_ group: String, _ key: String) -> Color {
        let preferences = NativePreferences.shared
        let mode = preferences.theme
        let lightID = preferences.lightColorTheme
        let darkID = preferences.darkColorTheme
        let increasedContrast = NativeThemeAccessibility.shared.increasedContrast
        let appearanceKey = "\(mode)|\(lightID)|\(darkID)|\(increasedContrast)"
        if appearanceKey != resolvedKey {
            resolved.removeAll(keepingCapacity: true)
            resolvedKey = appearanceKey
        }
        let cacheKey = group + "." + key
        if let color = resolved[cacheKey] { return color }
        let light = palettes[lightID].flatMap { $0.dark ? nil : $0 } ?? palettes["falcon-light"]
        let dark = palettes[darkID].flatMap { $0.dark ? $0 : nil } ?? palettes["falcon-dark"]
        func token(_ palette: NativeThemePalette?, increased: Bool) -> String {
            palette?.value(group, key, increasedContrast: increased)
                ?? palette?.value("fg", "primary", increasedContrast: increased) ?? "#17171c"
        }
        let color = Color(dynamicColor(light: token(light, increased: false), dark: token(dark, increased: false),
                                       increasedLight: token(light, increased: true), increasedDark: token(dark, increased: true), mode: mode,
                                       increasedContrast: increasedContrast))
        resolved[cacheKey] = color
        return color
    }

    nonisolated static func dynamicColor(light: String, dark: String, increasedLight: String? = nil,
                                        increasedDark: String? = nil, mode: String = "system", increasedContrast: Bool = false) -> NSColor {
        NSColor(name: nil) { appearance in
            let match = appearance.bestMatch(from: [.accessibilityHighContrastDarkAqua, .accessibilityHighContrastAqua, .darkAqua, .aqua])
            let increased = increasedContrast || match == .accessibilityHighContrastDarkAqua || match == .accessibilityHighContrastAqua
            let useDark = mode == "dark" || mode == "system" && (match == .darkAqua || match == .accessibilityHighContrastDarkAqua)
            return nsColor(useDark ? (increased ? increasedDark ?? dark : dark) : (increased ? increasedLight ?? light : light))
        }
    }

    nonisolated private static func nsColor(_ value: String) -> NSColor {
        if value.hasPrefix("#"), let hex = UInt32(value.dropFirst(), radix: 16) {
            return NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
        }
        let rgba = value.replacingOccurrences(of: "rgba(", with: "").replacingOccurrences(of: ")", with: "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard rgba.count == 4 else { return .labelColor }
        return NSColor(srgbRed: rgba[0] / 255, green: rgba[1] / 255, blue: rgba[2] / 255, alpha: rgba[3])
    }

    nonisolated static func color(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xff) / 255,
              green: Double((hex >> 8) & 0xff) / 255,
              blue: Double(hex & 0xff) / 255)
    }

    nonisolated static func providerName(_ provider: String) -> String {
        switch provider.lowercased() {
        case "claude": "Claude"
        case "codex": "Codex"
        default: provider.isEmpty ? "Agent" : provider.capitalized
        }
    }

    nonisolated static func statusLabel(_ status: String) -> String {
        switch status {
        case "running": "Working"
        case "waiting_for_input": "Needs a reply"
        case "awaiting_approval": "Needs approval"
        case "error", "failed": "Failed"
        case "idle", "completed", "ready": "Ready"
        case "interrupted": "Stopped"
        default: status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    @MainActor static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// AppKit may normalize named high-contrast appearances to Aqua. Observe the
/// actual accessibility preference so native colors also react to its changes.
@MainActor @Observable private final class NativeThemeAccessibility {
    static let shared = NativeThemeAccessibility()
    private(set) var increasedContrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
    @ObservationIgnored private var observer: NSObjectProtocol?

    private init() {
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.increasedContrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
            }
        }
    }
}

/// The "something is running" mark. A SwiftUI symbol effect animates by asking
/// for a new display list on every frame, which keeps the whole window in a
/// layout-and-render cycle for as long as one task runs. Driving the pulse from
/// a Core Animation layer keeps it on the render server instead.
struct MacActivityDiamond: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var size: CGFloat = 8

    var body: some View {
        PulsingDiamond(color: FDTheme.accent, animated: !reduceMotion)
            .frame(width: size, height: size)
            .accessibilityLabel("Working")
    }
}

private struct PulsingDiamond: NSViewRepresentable {
    let color: Color
    let animated: Bool

    func makeNSView(context: Context) -> DiamondView { DiamondView(frame: .zero) }

    func updateNSView(_ nsView: DiamondView, context: Context) {
        nsView.apply(color: NSColor(color), animated: animated)
    }

    final class DiamondView: NSView {
        private let shape = CAShapeLayer()
        private var tint: NSColor = .controlAccentColor
        private var animated = false

        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect)
            wantsLayer = true
            layer?.addSublayer(shape)
        }

        @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

        override var isFlipped: Bool { true }
        override var wantsUpdateLayer: Bool { true }

        func apply(color: NSColor, animated: Bool) {
            tint = color
            self.animated = animated
            needsLayout = true
            needsDisplay = true
        }

        override func layout() {
            super.layout()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            shape.frame = bounds
            let side = min(bounds.width, bounds.height)
            let path = CGMutablePath()
            path.move(to: CGPoint(x: side / 2, y: 0))
            path.addLine(to: CGPoint(x: side, y: side / 2))
            path.addLine(to: CGPoint(x: side / 2, y: side))
            path.addLine(to: CGPoint(x: 0, y: side / 2))
            path.closeSubpath()
            shape.path = path
            CATransaction.commit()
            refreshPulse()
        }

        override func updateLayer() {
            shape.fillColor = tint.cgColor
            refreshPulse()
        }

        override func viewDidChangeEffectiveAppearance() {
            super.viewDidChangeEffectiveAppearance()
            needsDisplay = true
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            // Layer animations are removed when a view leaves the window.
            refreshPulse()
        }

        private func refreshPulse() {
            guard animated, window != nil else {
                shape.removeAnimation(forKey: "pulse")
                shape.opacity = 1
                return
            }
            guard shape.animation(forKey: "pulse") == nil else { return }
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1
            pulse.toValue = 0.3
            pulse.duration = 0.85
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            shape.add(pulse, forKey: "pulse")
        }
    }
}

/// Only states that ask something of you get a mark. A settled task draws an
/// empty slot so titles stay aligned without a row of inert outlines.
struct TaskStatusMark: View {
    let status: String

    private var isSettled: Bool {
        !["running", "awaiting_approval", "waiting_for_input", "error", "failed"].contains(status)
    }

    var body: some View {
        Group {
            if status == "running" {
                MacActivityDiamond()
            } else if ["awaiting_approval", "waiting_for_input"].contains(status) {
                Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(FDTheme.warning)
            } else if ["error", "failed"].contains(status) {
                Image(systemName: "exclamationmark.circle.fill").font(.system(size: 10)).foregroundStyle(FDTheme.danger)
            } else {
                Color.clear
            }
        }
        .frame(width: 12, height: 14)
        .accessibilityHidden(isSettled)
        .accessibilityLabel(FDTheme.statusLabel(status))
    }
}

struct NativeEmptyState: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(FDTheme.muted)
                .frame(width: 58, height: 58)
                .background(FDTheme.raised, in: .rect(cornerRadius: 16))
            Text(title).font(NativePreferences.shared.font(size: 18, weight: .semibold)).foregroundStyle(FDTheme.foreground)
            Text(detail)
                .font(NativePreferences.shared.font(size: 14))
                .foregroundStyle(FDTheme.muted)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
                .frame(maxWidth: 300)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct NativeIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(NativePreferences.shared.font(size: 13, weight: .medium))
            .foregroundStyle(configuration.isPressed ? FDTheme.foreground : FDTheme.muted)
            .frame(width: 28, height: 28)
            .background(configuration.isPressed ? FDTheme.hover : Color.clear, in: .rect(cornerRadius: 6))
            .contentShape(.rect)
    }
}
