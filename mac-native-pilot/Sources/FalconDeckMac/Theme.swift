import AppKit
import SwiftUI

/// Falcon dark, mirrored from DESIGN.md and the shared product tokens.
enum FDTheme {
    static let background = color(0x09090b)
    static let surface = color(0x111113)
    static let raised = color(0x1a1a1f)
    static let hover = color(0x232329)
    static let foreground = color(0xf4f4f6)
    static let secondary = color(0xc4c4cc)
    static let muted = color(0x9d9da8)
    static let subtle = color(0x84848f)
    static let accent = color(0x34d399)
    static let accentStrong = color(0x6ee7b7)
    static let accentMuted = accent.opacity(0.14)
    static let accentDim = accent.opacity(0.07)
    static let line = Color.white.opacity(0.10)
    static let hairline = Color.white.opacity(0.06)
    static let warning = color(0xfbbf24)
    static let danger = color(0xf87171)
    static let info = color(0x60a5fa)

    static func color(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xff) / 255,
              green: Double((hex >> 8) & 0xff) / 255,
              blue: Double(hex & 0xff) / 255)
    }

    static func providerName(_ provider: String) -> String {
        switch provider.lowercased() {
        case "claude": "Claude"
        case "codex": "Codex"
        default: provider.isEmpty ? "Agent" : provider.capitalized
        }
    }

    static func statusLabel(_ status: String) -> String {
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

struct MacActivityDiamond: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var size: CGFloat = 8

    var body: some View {
        Image(systemName: "diamond.fill")
            .font(.system(size: size))
            .foregroundStyle(FDTheme.accent)
            .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
            .accessibilityLabel("Working")
    }
}

struct TaskStatusMark: View {
    let status: String

    var body: some View {
        Group {
            if status == "running" {
                MacActivityDiamond()
            } else if ["awaiting_approval", "waiting_for_input"].contains(status) {
                Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(FDTheme.warning)
            } else if ["error", "failed"].contains(status) {
                Image(systemName: "exclamationmark.circle.fill").font(.system(size: 10)).foregroundStyle(FDTheme.danger)
            } else {
                Image(systemName: "circle").font(.system(size: 6)).foregroundStyle(FDTheme.subtle)
            }
        }
        .frame(width: 12, height: 14)
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
            Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(FDTheme.foreground)
            Text(detail)
                .font(.system(size: 13))
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
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(configuration.isPressed ? FDTheme.foreground : FDTheme.muted)
            .frame(width: 28, height: 28)
            .background(configuration.isPressed ? FDTheme.hover : Color.clear, in: .rect(cornerRadius: 6))
            .contentShape(.rect)
    }
}
