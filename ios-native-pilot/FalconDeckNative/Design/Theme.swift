import SwiftUI

/// Falcon dark tokens from DESIGN.md, centralized for this independent client.
enum FD {
    static let background = Color(red: 9/255, green: 9/255, blue: 11/255)
    static let surface = Color(red: 17/255, green: 17/255, blue: 19/255)
    static let raised = Color(red: 26/255, green: 26/255, blue: 31/255)
    static let foreground = Color(red: 244/255, green: 244/255, blue: 246/255)
    static let secondary = Color(red: 157/255, green: 157/255, blue: 168/255)
    static let muted = Color(red: 132/255, green: 132/255, blue: 143/255)
    static let accent = Color(red: 52/255, green: 211/255, blue: 153/255)
    static let line = Color.white.opacity(0.10)
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
