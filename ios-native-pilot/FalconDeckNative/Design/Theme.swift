import SwiftUI

/// Falcon dark tokens from DESIGN.md, centralized for this independent client.
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var rotate = false
    var body: some View {
        Image(systemName: "diamond.fill")
            .font(.caption2).foregroundStyle(FD.accent)
            .rotationEffect(.degrees(rotate && !reduceMotion ? 180 : 0))
            .animation(reduceMotion ? nil : .easeInOut(duration: 1.5).repeatForever(autoreverses: true), value: rotate)
            .onAppear { rotate = true }
            .accessibilityLabel("Loading")
    }
}

struct ProjectIcon: View {
    let name: String
    var body: some View {
        if name.localizedCaseInsensitiveContains("falcon") {
            Image("FalconMark").resizable().scaledToFit().frame(width: 28, height: 28)
        } else { Image(systemName: FD.symbol(for: name)) }
    }
}

struct StatusBadge: View {
    let task: AgentTask
    var body: some View {
        HStack(spacing: 5) {
            if task.running { ActivityDiamond() }
            else { Circle().fill(color).frame(width: 5, height: 5) }
            Text(label).font(.caption.weight(.medium))
        }
        .foregroundStyle(color)
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(color.opacity(0.10), in: Capsule())
        .accessibilityElement(children: .combine)
    }
    private var color: Color { task.running ? FD.accent : task.needsAttention ? .orange : FD.secondary }
    private var label: String {
        if task.running { return "Working" }
        if task.status == "error" { return "Error" }
        if task.needsAttention { return "Needs you" }
        return "Ready"
    }
}

struct TaskRow: View {
    let task: AgentTask
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: task.provider == "claude" ? "sun.max" : "terminal")
                    .foregroundStyle(FD.secondary)
                Text(task.provider.capitalized).foregroundStyle(FD.secondary)
                Spacer()
                StatusBadge(task: task)
            }.font(.caption.weight(.medium))
            Text(task.title).font(.headline).foregroundStyle(FD.foreground).multilineTextAlignment(.leading)
            if !task.preview.isEmpty {
                Text(task.preview).font(.subheadline).foregroundStyle(FD.secondary)
                    .lineLimit(2).multilineTextAlignment(.leading)
            }
            HStack {
                if task.pinned { Label("Pinned", systemImage: "pin.fill") }
                Spacer()
                Image(systemName: "arrow.up.right").accessibilityHidden(true)
            }.font(.caption).foregroundStyle(FD.muted)
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background(FD.surface, in: .rect(cornerRadius: FD.radius))
        .overlay { RoundedRectangle(cornerRadius: FD.radius).strokeBorder(FD.line) }
        .contentShape(.rect)
    }
}

struct ConnectionPill: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Button { model.showConnection = true } label: {
            HStack(spacing: 7) {
                Circle().fill(model.demo ? FD.secondary : model.connected ? FD.accent : .orange).frame(width: 6, height: 6)
                Text(model.demo ? "Demo" : model.connected ? "Live" : "Connect").font(.subheadline.weight(.medium))
            }.padding(.horizontal, 4)
        }
        .foregroundStyle(FD.foreground)
        .accessibilityLabel("Connection: \(model.status)")
        .accessibilityIdentifier("connection")
    }
}
